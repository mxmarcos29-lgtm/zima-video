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
    def __init__(self, model_dir, prefer_gpu=True, det_size=640):
        self.det = make_session(os.path.join(model_dir, 'det_10g.onnx'), prefer_gpu)
        self.rec = make_session(os.path.join(model_dir, 'w600k_r50.onnx'), prefer_gpu)
        self.det_size = det_size
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

    def embed(self, faces112):
        """faces112: lista de rostos alinhados BGR 112x112 → matriz Nx512 normalizada."""
        if not faces112:
            return np.zeros((0, 512), dtype=np.float32)
        blob = cv2.dnn.blobFromImages(faces112, 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        out = []
        for i in range(0, len(blob), 32):
            e = self.rec.run(None, {self.rec_in: blob[i:i + 32]})[0]
            out.append(e)
        e = np.concatenate(out).astype(np.float32)
        return e / np.maximum(np.linalg.norm(e, axis=1, keepdims=True), 1e-9)

    def analyze(self, img, min_size=40, min_score=0.6):
        """Rostos de uma imagem: [{box, score, kps, emb, aligned}]"""
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
        embs = self.embed([f['aligned'] for f in found])
        for f, e in zip(found, embs):
            f['emb'] = e
        return found


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
