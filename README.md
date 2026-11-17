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
- Vídeo vertical abre a tela cheia em pé; o botão ⟳ (ou a tecla `R`) alterna entre vertical e horizontal
- Botão "voltar" do Android minimiza o player / fecha menus
- Velocidade (0,25x a 3x), legendas (.srt/.vtt/.ass externas e embutidas), faixas de áudio, qualidade (1080p/720p/480p/360p), repetir, reprodução automática do próximo arquivo da pasta, picture-in-picture
- Continua de onde você parou; seção "Continuar assistindo" no início
- Controles na tela de bloqueio/notificação (Media Session)
- Teclado (desktop): `espaço`/`K` play, `J`/`L` ±10s, `←`/`→` ±5s, `↑`/`↓` volume, `F` tela cheia, `M` mudo, `C` legendas, `I` mini player, `Shift+N`/`Shift+P` próximo/anterior, `<`/`>` velocidade, `0`–`9` pular para 0–90%

**Arquivos**
- Navegação por pastas com trilha (breadcrumbs), lista ou grade, ordenação por nome/data/tamanho
- Miniaturas geradas automaticamente a partir do vídeo
- Prévia em vídeo nas miniaturas (estilo YouTube): no celular a miniatura no centro da tela toca sozinha ao parar de rolar; no computador, ao passar o mouse. Pode ser desligada no menu ⋮ (e é desligada automaticamente com "economia de dados" ativada)
- Pesquisa por nome em todas as pastas ou só na pasta atual (ignora acentos)
- **Modo discreto** (botão de olho no topo ou tecla `D`): esconde as miniaturas sem baixá-las; a prévia em vídeo continua funcionando ao passar o mouse/arrastar o dedo
- Favoritos: pastas e arquivos favoritos aparecem no topo do início (salvos no servidor, iguais em todos os aparelhos). Favorite pelo menu ⋮ do item, pelo menu do topo (pasta atual) ou pelo botão no player
- Pressionar e segurar um item: favoritar, baixar, copiar link, reproduzir do início, marcar como assistido
- Visualizador de fotos: deslizar para a próxima/anterior, pinça ou toque duplo para zoom (roda do mouse no PC), arrastar para baixo para fechar, apresentação automática; no PC `←`/`→`, `+`/`-`, `0`, espaço
- Prévia em vídeo: além da escolha automática, deslize o dedo na horizontal sobre uma miniatura para percorrer a prévia
- No computador: barra lateral com favoritos e pastas, pesquisa no topo (`/`), player em duas colunas, mini player flutuante e prévia do quadro ao passar o mouse na barra de progresso

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

## Novidades no computador

- **Player:** anterior/play/próximo, volume (passe o mouse no alto-falante), tempo, legendas, configurações, modo teatro, PiP e tela cheia na barra inferior; barra de progresso que engrossa e mostra a miniatura ao passar o mouse.
- **Modo teatro** (botão ▭ ou tecla `T`): o vídeo ocupa toda a janela, a lista vai para baixo.
- **Tela dividida:** até 4 vídeos ao mesmo tempo. Abra pelo menu ⋮ de um vídeo → *Abrir na tela dividida*, pelo ⚙ do player ou pelo botão **+**. Clique num vídeo para ouvir o som dele, duplo clique amplia, teclas `1`–`4` selecionam.

## Visualizações

- Cada vídeo conta uma visualização depois de ~30s assistidos (ou 40% em vídeos curtos); guardado no servidor (`views.json`), igual em todos os aparelhos. A lista mostra "3 visualizações · visto ontem".
- Menu ⋮ → **Ordenar por**: mais vistos, menos vistos, vistos recentemente, vistos há mais tempo/nunca.
- Menu ⋮ → **Mostrar**: todos, nunca vistos, já vistos, em andamento, vistos nos últimos 7 dias, não vistos há mais de 30 dias.

## Desempenho

- **Pré-geração:** depois de iniciar, o servidor prepara miniaturas, prévias em vídeo e storyboards de toda a biblioteca em segundo plano (nice 19, pausa durante reprodução/navegação). O andamento aparece no menu ⋮. Primeira passada pode levar um tempo em bibliotecas grandes; arquivos novos são pegos a cada 30 min.
- **Storyboard:** a prévia ao arrastar/passar o mouse na barra de progresso vem de folhas de miniaturas do vídeo todo — instantânea.
- **Navegação:** pastas já visitadas abrem na hora (atualizam por trás); ao trocar de pasta, pedidos pendentes são cancelados; miniaturas que ainda estão sendo geradas não seguram conexões (o app tenta de novo e as visíveis passam na frente da fila).
- **Cache:** miniaturas, prévias e storyboards são guardados no navegador para sempre (a URL muda se o arquivo mudar); informações dos vídeos ficam salvas em disco; app e listas vão comprimidos (gzip).

## Gerenciar arquivos (modo administrador) e tags

1. No app: menu ⋮ → **Criar senha de administrador** (só aparece enquanto não existe senha; depois vira **Entrar no modo administrador**). Para trocar: menu ⋮ → *Trocar senha de administrador*. Alternativa: definir a variável `ADMIN_PASSWORD` no app (tem prioridade).
2. As pastas precisam estar graváveis (sem `:ro` nos volumes). Se estiverem somente leitura, o próprio menu avisa quais e como liberar.
3. Selecionar vários: segure um item e arraste o dedo pelos outros (celular), ou Ctrl/⌘+clique, Shift+clique e arrastar um retângulo com o mouse (PC). **Selecionar tudo** fica na barra de seleção e no menu ⋮. A barra tem **Tags**, **Mover**, **Renomear** e **Excluir**. No PC: `Ctrl+A`, `F2` renomeia, `Delete` exclui, `Esc` sai.
   - **Renomear em lote** (vários selecionados → ✏): *Novo nome* com numeração (`Férias ##` → Férias 01, 02…), *Acrescentar* texto antes/depois do nome ou *Substituir* um trecho; prévia mostra antes → depois e bloqueia nomes repetidos.
   - **Mover:** pesquise a pasta de destino (no servidor inteiro) ou use os destinos recentes.
4. Pelo menu ⋮ de cada item também dá para renomear, mover, excluir e editar tags; no menu do topo, **Nova pasta aqui** e **Lixeira**.

- **Excluir vai para a lixeira** (pasta oculta `.zima-lixeira` no mesmo disco). Restaure ou apague definitivamente em ⋮ → *Lixeira*.
- Pastas de volume (DATA, Discos) não podem ser renomeadas, movidas nem excluídas.
- Favoritos, tags e progresso acompanham arquivos renomeados ou movidos.
- **Tags:** cada tag tem uma cor; marque em vários itens de uma vez (estado misto quando só parte tem a tag). Filtre a pasta atual pela barra de tags, ou abra uma tag (início, barra lateral) para ver os itens dela em todas as pastas. Renomear, mudar a cor ou excluir uma tag: ⋮ ao lado dela.

## Pessoas (reconhecer atores/atrizes)

Menu ⋮ → **Pessoas** (modo administrador). Só reconhece as pessoas que **você** nomeia — nada é consultado na internet.

- **Pelo nome do arquivo:** procura o nome de cada pessoa (e apelidos) no nome dos vídeos, ignorando maiúsculas, acentos, pontos, traços e “_”. Também lista nomes que se repetem em vários arquivos para virar pessoa com um toque. Você confere e aplica as tags.
- **Pelo rosto:** um **ajudante** roda no seu PC e usa a placa de vídeo (DirectML: AMD, NVIDIA ou Intel) para encontrar e comparar os rostos; o NAS só guarda os resultados. Os rostos parecidos aparecem em grupos: dê o nome uma vez e a pessoa passa a ser sugerida nos outros vídeos.
- **Excluir pastas da análise de rosto:** ⋮ numa pasta → “Não analisar rostos nesta pasta”, ou Pessoas → **Pastas excluídas**. Vale para as subpastas; os rostos já encontrados nelas somem dos grupos e das sugestões (e voltam se a pasta for incluída de novo).
- Qualquer tag pode ser marcada como **pessoa** (⋮ ao lado da tag → “É uma pessoa”, com outras formas do nome).

### Instalar o ajudante no Windows
1. No app: Pessoas → **Conectar ajudante** → *Baixar o ajudante (.zip)*.
2. Extraia num lugar fixo e abra `instalar.bat` (instala o Python 3.12 e os componentes, e baixa os modelos ~290 MB na primeira vez).
3. Informe o endereço e o código gerado no app.
4. Use `iniciar.bat` (ou `iniciar_com_o_windows.bat` para abrir junto com o Windows).

Os modelos de rosto (InsightFace buffalo_l) são de uso **não comercial**.

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
| `PREVIEWS` | `1` | `0` desativa as prévias em vídeo |
| `PREGEN` | `all` | Prepara em segundo plano (prioridade mínima, pausa enquanto alguém assiste): `all` = miniaturas + prévias + storyboards, `thumbs` = só miniaturas, `off` = desligado |
| `PREVIEW_CONCURRENCY` | `1` | Prévias geradas em paralelo |
| `SEARCH_INDEX_TTL` | `600` | Segundos até reindexar a pesquisa |
| `DATA_DIR` | `CACHE_DIR` | Onde ficam `favorites.json`, `tags.json` e `trash.json` |
| `ADMIN_PASSWORD` | vazio | Senha do modo administrador (opcional: dá para criar a senha pelo app) |
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
