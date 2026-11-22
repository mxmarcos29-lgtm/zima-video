"""Motor de rostos do ajudante do Zima Video.

Detecção: SCRFD (det_10g.onnx) · Assinatura: ArcFace (w600k_r50.onnx) — modelos "buffalo_l" do InsightFace.
Implementado só com onnxruntime + numpy + opencv (sem o pacote insightface, que no Windows exige compilador).
No Windows usa a placa de vídeo pelo DirectML (AMD, NVIDIA ou Intel); sem ela, usa o processador.
"""
import os
import numpy as np
import cv2
import onnxruntime as ort

# posição padrão dos 5 pontos (olhos, nariz, cantos da boca) num rosto alinhado 112x112 (ArcFace)
ARC_DST = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                    [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)


def readable_error(e):
    """Mensagem de erro legível. No Windows em português, erros da placa de vídeo (DirectML) vêm em
    cp1252 (ex.: "O parâmetro está incorreto") e o onnxruntime tenta ler como UTF-8, virando
    "'utf-8' codec can't decode byte 0xe2...". Recupera o texto original quando dá."""
    if isinstance(e, UnicodeDecodeError):
        try:
            return 'erro da placa de vídeo: ' + e.object.decode('cp1252', errors='replace').strip()[:300]
        except Exception:
            return 'erro da placa de vídeo (mensagem ilegível do Windows)'
    return str(e)


class SafeSession:
    """Sessão do onnxruntime que não deixa um erro da placa de vídeo derrubar a análise:
    1) se um lote falha na placa, tenta de novo um rosto por vez (alguns drivers recusam lotes);
    2) se continua falhando, faz aquele pedaço no processador;
    3) depois de várias falhas seguidas, passa esse modelo de vez para o processador."""

    def __init__(self, path, prefer_gpu=True, log=None):
        self.path = path
        self.log = log or (lambda m: None)
        self.sess = make_session(path, prefer_gpu)
        self.cpu = None
        self.fails = 0
        self.gpu = self.sess.get_providers()[0] != 'CPUExecutionProvider'

    def get_inputs(self): return self.sess.get_inputs()
    def get_outputs(self): return self.sess.get_outputs()
    def get_providers(self): return self.sess.get_providers()

    def _cpu(self):
        if self.cpu is None:
            self.cpu = make_session(self.path, prefer_gpu=False)
        return self.cpu

    def run(self, names, feeds):
        if not self.gpu:
            return self.sess.run(names, feeds)
        try:
            out = self.sess.run(names, feeds)
            self.fails = 0
            return out
        except Exception as e:  # inclui o UnicodeDecodeError do Windows em português
            msg = readable_error(e)
        # lote recusado pela placa: um por vez
        name, arr = next(iter(feeds.items()))
        if len(feeds) == 1 and getattr(arr, 'shape', (1,))[0] > 1:
            try:
                parts = [self.sess.run(names, {name: arr[i:i + 1]}) for i in range(arr.shape[0])]
                self.fails = 0
                return [np.concatenate([p[k] for p in parts]) for k in range(len(parts[0]))]
            except Exception as e2:
                msg = readable_error(e2)
        self.fails += 1
        if self.fails >= 3:
            self.gpu = False; self.sess = self._cpu()
            self.log(f'A placa de vídeo falhou várias vezes em {os.path.basename(self.path)} ({msg}). Continuando no processador.')
        else:
            self.log(f'A placa de vídeo falhou ({msg}); refeito no processador.')
        return self._cpu().run(names, feeds)


def make_session(path, prefer_gpu=True):
    avail = ort.get_available_providers()
    providers = []
    if prefer_gpu:
        for p in ('DmlExecutionProvider', 'CUDAExecutionProvider', 'ROCMExecutionProvider', 'CoreMLExecutionProvider'):
            if p in avail:
                providers.append(p)
    providers.append('CPUExecutionProvider')
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    if 'DmlExecutionProvider' in providers:
        # recomendação do onnxruntime para o DirectML: sem "memory pattern" e execução sequencial
        # (sem isso o DirectML pode recusar operações — "O parâmetro está incorreto")
        opts.enable_mem_pattern = False
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    try:
        return ort.InferenceSession(path, sess_options=opts, providers=providers)
    except Exception:
        return ort.InferenceSession(path, sess_options=opts, providers=['CPUExecutionProvider'])


def _nms(dets, thresh=0.4):
    x1, y1, x2, y2, scores = dets[:, 0], dets[:, 1], dets[:, 2], dets[:, 3], dets[:, 4]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]]); yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]]); yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1 + 1); h = np.maximum(0.0, yy2 - yy1 + 1)
        ovr = (w * h) / (areas[i] + areas[order[1:]] - w * h)
        order = order[np.where(ovr <= thresh)[0] + 1]
    return keep


class FaceEngine:
    def __init__(self, model_dir, prefer_gpu=True, det_size=None, log=None):
        self.det = SafeSession(os.path.join(model_dir, 'det_10g.onnx'), prefer_gpu, log)
        self.rec = SafeSession(os.path.join(model_dir, 'w600k_r50.onnx'), prefer_gpu, log)
        self.gpu = self.det.gpu
        # 640 basta: rostos menores que ~36 px (o mínimo aceito) dão assinaturas ruins de qualquer jeito;
        # a folga da placa vai para mais pontos por vídeo (testado: 960 não achou mais rostos úteis)
        self.det_size = det_size or 640
        self.det_in = self.det.get_inputs()[0].name
        self.det_out = [o.name for o in self.det.get_outputs()]
        self.rec_in = self.rec.get_inputs()[0].name
        self.provider = self.det.get_providers()[0]
        self._centers = {}

    # ---------------------------------------------------------------- detecção (SCRFD)
    def detect(self, img, thresh=0.5):
        """img: BGR (opencv). Retorna lista de (box[x1,y1,x2,y2], score, kps[5x2])."""
        h, w = img.shape[:2]
        S = self.det_size
        scale = min(S / w, S / h)
        nw, nh = int(round(w * scale)), int(round(h * scale))
        canvas = np.zeros((S, S, 3), dtype=np.uint8)
        canvas[:nh, :nw] = cv2.resize(img, (nw, nh))
        blob = cv2.dnn.blobFromImage(canvas, 1.0 / 128, (S, S), (127.5, 127.5, 127.5), swapRB=True)
        outs = self.det.run(self.det_out, {self.det_in: blob})
        fmc = 3
        boxes, scores, kpss = [], [], []
        for idx, stride in enumerate((8, 16, 32)):
            sc = outs[idx].reshape(-1)
            bb = outs[idx + fmc].reshape(-1, 4) * stride
            kp = outs[idx + fmc * 2].reshape(-1, 10) * stride
            fh, fw = S // stride, S // stride
            key = (fh, fw, stride)
            if key not in self._centers:
                c = np.stack(np.mgrid[:fh, :fw][::-1], axis=-1).astype(np.float32)
                c = (c * stride).reshape(-1, 2)
                c = np.stack([c] * 2, axis=1).reshape(-1, 2)  # 2 âncoras por posição
                self._centers[key] = c
            centers = self._centers[key]
            pos = np.where(sc >= thresh)[0]
            if not len(pos):
                continue
            c = centers[pos]
            b = bb[pos]
            boxes.append(np.stack([c[:, 0] - b[:, 0], c[:, 1] - b[:, 1], c[:, 0] + b[:, 2], c[:, 1] + b[:, 3]], axis=-1))
            k = kp[pos].reshape(-1, 5, 2) + c[:, None, :]
            kpss.append(k)
            scores.append(sc[pos])
        if not boxes:
            return []
        boxes = np.concatenate(boxes) / scale
        kpss = np.concatenate(kpss) / scale
        scores = np.concatenate(scores)
        dets = np.hstack([boxes, scores[:, None]]).astype(np.float32)
        keep = _nms(dets)
        return [(dets[i, :4], float(dets[i, 4]), kpss[i]) for i in keep]

    # ---------------------------------------------------------------- assinatura (ArcFace)
    @staticmethod
    def align(img, kps, size=112):
        M, _ = cv2.estimateAffinePartial2D(kps.astype(np.float32), ARC_DST, method=cv2.LMEDS)
        if M is None:
            return None
        return cv2.warpAffine(img, M, (size, size), borderValue=0.0)

    def embed(self, faces112, flip=True):
        """faces112: rostos alinhados BGR 112x112 → (Nx512 normalizada, norma bruta por rosto).
        flip: soma a assinatura do rosto com a do rosto espelhado (prática padrão na avaliação do ArcFace:
        deixa a assinatura mais estável a pose e iluminação de um lado só). A norma bruta (antes de
        normalizar) acompanha a "reconhecibilidade" do rosto e entra na nota de qualidade."""
        if not faces112:
            return np.zeros((0, 512), dtype=np.float32), np.zeros((0,), dtype=np.float32)
        imgs = list(faces112) + ([cv2.flip(f, 1) for f in faces112] if flip else [])
        blob = cv2.dnn.blobFromImages(imgs, 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        out = []
        step = 64 if self.rec.gpu else 16
        for i in range(0, len(blob), step):
            out.append(self.rec.run(None, {self.rec_in: blob[i:i + step]})[0])
        e = np.concatenate(out).astype(np.float32)
        n = len(faces112)
        norms = np.linalg.norm(e, axis=1)
        if flip:
            e = e[:n] + e[n:]
            norms = (norms[:n] + norms[n:]) / 2
        e = e / np.maximum(np.linalg.norm(e, axis=1, keepdims=True), 1e-9)
        return e, norms.astype(np.float32)

    def analyze(self, img, min_size=36, min_score=0.55, flip=True):
        """Rostos de uma imagem: [{box, score, kps, emb, aligned, q, qd}] (q = qualidade 0..1)"""
        return self.analyze_many([img], min_size, min_score, flip)[0]

    def analyze_many(self, imgs, min_size=36, min_score=0.55, flip=True):
        """Vários quadros de uma vez: detecta em cada um e calcula as assinaturas de TODOS os rostos num
        lote só (a placa de vídeo rende muito mais com lotes grandes do que com vários pedidos pequenos)."""
        per = []
        allf = []
        for img in imgs:
            found = []
            for box, score, kps in self.detect(img):
                if score < min_score:
                    continue
                bw, bh = box[2] - box[0], box[3] - box[1]
                if min(bw, bh) < min_size:
                    continue
                a = self.align(img, kps)
                if a is None:
                    continue
                found.append({'box': box, 'score': score, 'kps': kps, 'aligned': a})
            per.append(found); allf += found
        embs, norms = self.embed([f['aligned'] for f in allf], flip=flip)
        for f, e, nm in zip(allf, embs, norms):
            f['emb'] = e
            f['q'], f['qd'] = face_quality(f, float(nm))
        return per


def face_quality(f, norm):
    """Nota de qualidade (0..1) de um rosto, para pesar as assinaturas e escolher as melhores.
    Junta o que os sistemas de fotos usam para descartar rostos ruins antes de agrupar:
    nitidez, tamanho, rosto de frente (pelos 5 pontos), confiança da detecção e a norma da assinatura."""
    x1, y1, x2, y2 = f['box']
    size = float(min(x2 - x1, y2 - y1))
    k = f['kps']
    le, re, nose = k[0], k[1], k[2]
    eye_d = max(1e-3, float(np.linalg.norm(re - le)))
    mid = (le + re) / 2
    yaw = abs(float(nose[0] - mid[0])) / eye_d                     # 0 = de frente; ~0,5+ = de perfil
    mouth = (k[3] + k[4]) / 2
    pitch = float(nose[1] - mid[1]) / max(1e-3, float(mouth[1] - mid[1]))   # ~0,55 de frente
    # nitidez relativa ao contraste (rosto escuro mas nítido continua bom; borrado cai muito)
    g = cv2.cvtColor(f['aligned'], cv2.COLOR_BGR2GRAY).astype(np.float64)[16:96, 16:96]
    sharp = float(cv2.Laplacian(g, cv2.CV_64F).var() / (g.std() ** 2 + 1))
    q_size = np.clip((size - 36) / (110 - 36), 0, 1)
    q_pose = np.clip(1 - yaw / 0.55, 0, 1) * np.clip(1 - abs(pitch - 0.55) / 0.45, 0, 1)
    q_sharp = np.clip(np.log10(max(sharp, 1e-4) / 0.004) / np.log10(0.08 / 0.004), 0, 1)
    q_det = np.clip((f['score'] - 0.55) / (0.85 - 0.55), 0, 1)
    q_norm = np.clip((norm - 15) / (25 - 15), 0, 1)
    q = 0.40 * q_sharp + 0.20 * q_pose + 0.20 * q_norm + 0.10 * q_size + 0.10 * q_det
    return round(float(q), 3), {'norm': round(norm, 1), 'yaw': round(yaw, 2), 'sharp': round(sharp, 3), 'size': round(size)}


def face_crop(img, box, size=160):
    """Recorte quadrado com folga ao redor do rosto (para mostrar no app)."""
    h, w = img.shape[:2]
    x1, y1, x2, y2 = box
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    s = max(x2 - x1, y2 - y1) * 1.5
    X1, Y1 = int(max(0, cx - s / 2)), int(max(0, cy - s / 2))
    X2, Y2 = int(min(w, cx + s / 2)), int(min(h, cy + s / 2))
    crop = img[Y1:Y2, X1:X2]
    if crop.size == 0:
        return None
    return cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)
