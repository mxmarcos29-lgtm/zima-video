# Zima Video

Explorador de arquivos + player de vídeo para o **ZimaOS**, pensado para o celular.
Navegue pelas pastas do servidor até o vídeo e assista direto no navegador, com gestos no estilo do YouTube.

## Recursos

**Player**
- Toque duplo na lateral esquerda/direita: volta/avança 10s (toques extras somam: 20s, 30s…)
- Segurar o vídeo: 2x enquanto o dedo estiver na tela
- Arrastar para o lado: busca com prévia do frame (miniatura) e diferença de tempo
- Arrastar a barra de progresso: prévia do frame na posição
- Arrastar para baixo: minimiza para o mini player (o vídeo continua tocando enquanto você navega)
- Mini player: tocar ou arrastar para cima maximiza; arrastar para o lado fecha
- Arrastar para cima: tela cheia · arrastar para baixo em tela cheia: sai
- Pinça em tela cheia: zoom para preencher a tela
- Toque duplo no centro: tela cheia
- Botão "voltar" do Android minimiza o player / fecha menus
- Velocidade (0,25x a 3x), legendas (.srt/.vtt/.ass externas e embutidas), faixas de áudio, qualidade (1080p/720p/480p/360p), repetir, reprodução automática do próximo arquivo da pasta, picture-in-picture
- Continua de onde você parou; seção "Continuar assistindo" no início
- Controles na tela de bloqueio/notificação (Media Session)
- Teclado (desktop): `espaço`/`K` play, `J`/`L` ±10s, `←`/`→` ±5s, `↑`/`↓` volume, `F` tela cheia, `M` mudo, `C` legendas, `I` mini player, `Shift+N`/`Shift+P` próximo/anterior, `<`/`>` velocidade, `0`–`9` pular para 0–90%

**Arquivos**
- Navegação por pastas com trilha (breadcrumbs), lista ou grade, ordenação por nome/data/tamanho
- Miniaturas geradas automaticamente a partir do vídeo
- Pesquisa por nome em todas as pastas ou só na pasta atual (ignora acentos)
- Pressionar e segurar um item: baixar, copiar link, reproduzir do início, marcar como assistido
- Visualizador de imagens

**Formatos**
O app escolhe automaticamente a forma mais leve de reproduzir:

| Modo | Quando | Custo no servidor |
|---|---|---|
| Direto | MP4/WebM/MOV com codecs suportados pelo navegador | nenhum |
| Remux | Ex.: MKV com H.264 (vídeo copiado, só o áudio é convertido) | muito baixo |
| Conversão (HLS) | AVI, WMV, FLV, MPEG, HEVC sem suporte, H.264 10-bit, iPhone, qualidade reduzida… | alto (ffmpeg) |

Vídeo: mp4, m4v, mkv, webm, mov, avi, wmv, flv, mpg/mpeg, ts/m2ts/mts, vob, 3gp, ogv, asf, rm/rmvb, divx, f4v, mxf…
Áudio: mp3, m4a, aac, flac, wav, ogg, opus, wma, alac, aiff, ape…

Se a reprodução direta falhar, o player tenta o próximo modo sozinho. No menu ⚙ há a opção "Forçar conversão".

## Instalação no ZimaOS

### Opção 1 — Importar o compose (recomendado)

1. Este repositório tem um GitHub Action que publica a imagem em `ghcr.io/mxmarcos29-lgtm/zima-video`.
   Depois do primeiro push na branch `main`, abra **GitHub → seu perfil → Packages → zima-video → Package settings** e mude a visibilidade para **Public** (assim o ZimaOS consegue baixar sem login).
2. No ZimaOS abra a **App Store → ⋯ / "+" → Instalar app personalizado → Importar** e cole o conteúdo de [`docker-compose.yml`](docker-compose.yml).
3. Ajuste as pastas se quiser e instale. Acesse em `http://IP-DO-ZIMA:8096`.

### Opção 2 — Compilar no próprio servidor (via SSH)

```sh
git clone https://github.com/mxmarcos29-lgtm/zima-video.git
cd zima-video
# no docker-compose.yml, troque a linha "image:" por "build: ."
docker compose up -d --build
```

### Pastas

Por padrão o compose monta (somente leitura):
- `/DATA` do ZimaOS → aparece como **DATA**
- `/media` (discos USB/externos) → aparece como **Discos**

Adicione outras linhas em `volumes:` no formato `/caminho/no/servidor:/media/Nome:ro`.

### Aceleração por hardware (Intel / AMD)

Converter vídeo por software pesa em CPUs pequenas (ex.: ZimaBoard). Com GPU Intel (N100, Celeron etc.):

```yaml
    environment:
      HWACCEL: vaapi
    devices:
      - /dev/dri:/dev/dri
```

Se a GPU falhar com algum arquivo, o servidor volta automaticamente para conversão por software.

### Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `MEDIA_ROOT` | `/media` | Pasta raiz exibida |
| `CACHE_DIR` | `/cache` | Miniaturas, legendas extraídas e segmentos HLS |
| `PORT` | `8080` | Porta HTTP |
| `HWACCEL` | `none` | `none` ou `vaapi` |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | Dispositivo VA-API |
| `X264_PRESET` | `veryfast` | Preset do x264 (`ultrafast` para CPUs fracas) |
| `AUTH_USER` / `AUTH_PASS` | vazio | Ativa login (HTTP Basic) |
| `THUMBNAILS` | `1` | `0` desativa miniaturas automáticas |
| `THUMB_CONCURRENCY` | `2` | Miniaturas geradas em paralelo |
| `SEARCH_INDEX_TTL` | `600` | Segundos até reindexar a pesquisa |
| `SHOW_HIDDEN` | `0` | `1` mostra arquivos ocultos (`.x`, `@eaDir`…) |

## Dicas

- **Adicionar à tela inicial** do celular (menu do navegador → "Adicionar à tela inicial") para abrir como app, em tela cheia.
- No iPhone a tela cheia é feita pelo próprio app (o Safari não permite tela cheia em elementos); gire o celular.
- Legendas externas são detectadas quando têm o mesmo nome do vídeo: `Filme.srt`, `Filme.pt-BR.srt`, `Filme.por.srt`.
- Legendas em imagem (PGS/VobSub, comuns em Blu-ray) não são suportadas.

## Desenvolvimento

Sem dependências npm — só Node.js ≥ 18 e `ffmpeg`/`ffprobe` no PATH.

```sh
MEDIA_ROOT=/caminho/dos/videos CACHE_DIR=./cache node server.js
```

Estrutura: `server.js` (API, streaming, conversão, miniaturas, pesquisa) e `public/` (interface em JS puro). `public/vendor/hls.light.min.js` é o [hls.js](https://github.com/video-dev/hls.js) (Apache-2.0).
