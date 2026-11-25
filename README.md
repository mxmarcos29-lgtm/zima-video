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
  Na mesma aba: **Pastas excluídas** (só da busca por nome), **✕** num arquivo encontrado (“não é esta pessoa”), **Não é nome** nos nomes repetidos, e a seção **Parece erro de digitação** (grafias quase iguais às de uma pessoa → “É a mesma pessoa” vira apelido). Pessoas cadastradas com nomes quase iguais aparecem num aviso para juntar.
  Cada nome encontrado pode ser **ajustado** (ex.: tirar a palavra a mais de “Carlos Pereira Show”) — o app confere de novo em quantos arquivos o nome aparece, mostra grafias parecidas e se já existe uma pessoa igual/parecida — ou ligado a **outra tag já criada** (vira um apelido dela e os arquivos passam a ser sugeridos para essa tag).
- **Pelo rosto:** um **ajudante** roda no seu PC e usa a placa de vídeo (DirectML: AMD, NVIDIA ou Intel) para encontrar e comparar os rostos; o NAS só guarda os resultados. Os rostos parecidos aparecem em grupos: dê o nome uma vez e a pessoa passa a ser sugerida nos outros vídeos.
- **Cruzamento tags × rostos:** os vídeos que já têm a tag de uma pessoa (manual ou pelo nome do arquivo) ensinam o reconhecimento. Se o vídeo tem um rosto só, ou o mesmo rosto se repete nos vídeos com a tag, ele aprende sozinho (marcado “auto” nos rostos da pessoa). Se houver dúvida — várias pessoas no vídeo — aparece uma **pergunta** em Pessoas; uma resposta costuma resolver vários vídeos. Tags comuns cujos vídeos têm sempre o mesmo rosto geram a pergunta “é uma pessoa?”.
- **Todas as tags (A–Z):** “Ver todas” no Início, “Todas as tags” na barra lateral ou no menu ⋮. Lista vertical em ordem alfabética, separada por letra, com busca (inclui apelidos), filtro Pessoas/Outras e um índice de letras na lateral — toque ou arraste o dedo para ir até a letra.
- **Juntar tags:** ⋮ da tag → “Juntar com outra tag…”, ou menu ⋮ → “Tags parecidas” (acha duplicadas por maiúsculas, acentos, pontuação, ordem das palavras, apelidos ou 1 letra diferente). O nome antigo vira apelido. Ao criar uma tag (inclusive automaticamente), uma equivalente que já existe é reaproveitada.
- **Excluir pastas da análise de rosto:** ⋮ numa pasta → “Não analisar rostos nesta pasta”, ou Pessoas → **Pastas excluídas**. Vale para as subpastas; os rostos já encontrados nelas somem dos grupos e das sugestões (e voltam se a pasta for incluída de novo).
- **Conferir um rosto:** a lupa (ou tocar no rosto) amplia mostrando o quadro do vídeo no momento em que o rosto foi encontrado, com setas para os outros rostos do grupo e o botão “Ver no vídeo neste momento”. O vídeo abre por cima da tela Pessoas — ao sair dele, você continua de onde estava.
- **Menos confusão entre pessoas:** um rosto só é reconhecido como a pessoa se concordar com vários rostos de referência dela (não basta parecer com um). Rostos de referência que destoam dos outros ficam marcados como **suspeito** e deixam de ser usados (nos rostos da pessoa há “Remover suspeitos” e “Desfazer o que foi aprendido sozinho”). Cada “não é esta pessoa” (✕ numa sugestão, remover um rosto, as outras opções de uma pergunta) vira um exemplo do que ela **não** é.
- Qualquer tag pode ser marcada como **pessoa** (⋮ ao lado da tag → “É uma pessoa”, com outras formas do nome).

### Como o reconhecimento funciona (análise v2)
Inspirado no que o Apple Fotos e o Google Fotos descrevem publicamente, adaptado para vídeo:
- **No PC (ajudante):** em cada ponto do vídeo lê uma rajada de 3 quadros seguidos e acompanha cada rosto entre eles (*trilha*: mesma trilha = mesma pessoa; rostos no mesmo quadro = pessoas diferentes). Cada rosto ganha uma **nota de qualidade** (nitidez, tamanho, rosto de frente, confiança da detecção e “força” da assinatura) e a assinatura é calculada com o rosto **espelhado** também. As aparições da mesma pessoa no vídeo são juntadas por agrupamento hierárquico respeitando essas regras, e a assinatura do grupo é a média ponderada pela qualidade — rostos borrados quase não contam.
- **No servidor (cruzamento):** cada pessoa aparece no máximo uma vez por vídeo; pessoas do mesmo vídeo nunca são juntadas; o nome da pessoa no nome do arquivo deixa o reconhecimento dela um pouco menos exigente ali; cada pessoa tem um **limite próprio** que sobe quando há “não é ela” parecidos (sósias/parentes); rostos sem nome são agrupados em duas passadas (conservadora + junção de grupos). Cada sugestão vem com **certeza alta** ou média, e grupos quase parecidos com alguém viram a pergunta **“É a mesma pessoa?”**.
- Ao atualizar o ajudante, os vídeos analisados pela versão antiga são refeitos sozinhos (depois dos novos), sem perder o que você já ensinou.

**No computador**, a tela Pessoas tem barra lateral com as pessoas e as áreas *Revisar*, *Rostos sem nome* e a página de cada pessoa: grades com seleção múltipla (Ctrl/Shift+clique), confirmar/recusar em lote, atalhos (setas, Espaço, **Y** confirma, **N** não é, **Z** amplia, **P** abre o vídeo, Ctrl+A) e arrastar um grupo de rostos até uma pessoa.

### Instalar o ajudante no Windows
1. No app: Pessoas → **Conectar ajudante** → *Baixar o ajudante (.zip)*.
2. Extraia num lugar fixo e abra `instalar.bat` (instala o Python 3.12 e os componentes, cria o atalho **Zima Video Ajudante** e abre o programa; os modelos ~290 MB são baixados na primeira vez). Para atualizar, extraia o .zip novo por cima e rode o `instalar.bat` de novo.
3. Na janela do ajudante, informe o endereço e o código gerado no app.

**Quanto do PC ele usa** (na janela do ajudante):
- **Automático:** um nível enquanto você usa o PC (padrão *Leve*) e outro quando o PC fica parado por X minutos (padrão *Máximo* após 5 min); pausa sozinho em jogos/filmes/apresentações em tela cheia e com o notebook na bateria.
- **Fixo:** Pausado, Leve (~25% do tempo, prioridade mínima), Médio (~60%) ou Máximo.
- Fechando a janela ele continua na **bandeja** (perto do relógio), com menu para pausar e trocar o nível; “Abrir junto com o Windows” inicia escondido na bandeja.

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

## Compressor (deixar vídeos menores sem bagunçar)

Modo administrador → ⋮ de uma pasta ou vídeo → **Comprimir…**, o botão de compressão na barra de seleção, ou menu ⋮ → **Compressor**.
- A versão comprimida fica **no mesmo lugar, com o mesmo nome e a mesma data**: tags, rostos, visualizações, favoritos e a ordem por data continuam valendo. Formatos antigos (AVI, WMV…) viram MP4 e a organização acompanha o novo nome. MKV continua MKV (com todas as faixas de áudio e legendas).
- O original vai para a **Lixeira** (dá para restaurar); o espaço é liberado ao esvaziar a lixeira. Antes de trocar, o arquivo novo é conferido (duração e vídeo); se não ficar pelo menos 8% menor, o original é mantido.
- Formatos: **Compatível (H.264)**, **Economia (H.265)** e **Máxima economia (AV1)** — o AV1 é o menor, mas aparelhos antigos podem não tocar direto (aí o NAS converte na hora para tocar). Opção de limitar a resolução (1080p/720p). Mostra a economia estimada antes de começar e pula vídeos que já estão compactos.
- **Qualidade em primeiro lugar (padrão):** presets caprichados (SVT-AV1 6 com variance boost, x265/x264 slow), sempre 10 bits em AV1/H.265, quadro-chave a cada ~10 s, áudio pesado (sem perda, PCM, DTS, TrueHD) vira Opus. Níveis *Visualmente igual* / *Equilibrada* / *Econômica*.
- **“Medir a qualidade antes” (ligado por padrão, só no PC):** como no *per-title encoding* da Netflix e no ab-av1, testa trechos de cada vídeo com **VMAF** e escolhe o ajuste mais econômico que mantém o nível (exigindo também os piores momentos), pulando o que não compensa.
- **Placa de vídeo:** AMD AMF, NVENC ou QSV com AQ e 10 bits (sem custo de tempo relevante na placa), com volta automática para ajustes básicos ou para o processador se a placa recusar.
- **Comprimir mesmo se não atingir o padrão** (opção): não pula vídeos que parecem já compactos, que não chegam na nota de qualidade ou que diminuiriam pouco; o original só é trocado se o arquivo novo ficar menor.
- **O que cada PC consegue:** o ajudante testa os codificadores do PC (placa e processador, com reservas para AV1: SVT-AV1, libaom, rav1e) e informa ao NAS; o Compressor mostra por PC o que funciona (e o motivo do que não funciona), e não manda a um PC um formato que ele não consegue. Cada vídeo da fila mostra em qual PC (ou no NAS) foi feito.
- **Pastas excluídas da compressão:** ⋮ de uma pasta → “Não comprimir os vídeos desta pasta”, ou Compressor → “Pastas excluídas da compressão”. O compressor nunca mexe nelas (nem quando você pede para comprimir uma pasta acima), e o que estava na fila dessas pastas sai da fila.
- **Onde comprimir:** no **PC**, pelo mesmo Zima Video Ajudante (usa a placa de vídeo — AMD AMF, incluindo AV1 nas RX 7000/9000, NVIDIA NVENC ou Intel QSV — ou o processador), ou no **NAS** (mais lento). O ajudante só comprime nos níveis Médio e Máximo: quando você volta a usar o PC, a compressão congela e continua depois sem perder o que já foi feito.

## Pasta de cache dentro da biblioteca

Na instalação padrão o cache fica em `/DATA/AppData/zima-video/cache`, que também está dentro de `/DATA` (a biblioteca). O app marca a própria pasta de cache (arquivo `.zima-video-cache`) e a reconhece mesmo vista pelo caminho da biblioteca: ela não aparece na lista, na busca, nas tags, nas sugestões nem na análise de rosto. Tags e análises que tenham ido parar em arquivos do cache em versões antigas são apagadas sozinhas.

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
