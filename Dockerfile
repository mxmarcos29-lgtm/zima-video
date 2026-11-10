FROM node:22-alpine

# ffmpeg (conversão/miniaturas) + drivers VA-API para aceleração por hardware em CPUs Intel/AMD
RUN apk add --no-cache ffmpeg tini \
 && if [ "$(uname -m)" = "x86_64" ]; then apk add --no-cache intel-media-driver libva-intel-driver mesa-va-gallium || true; fi

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

ENV MEDIA_ROOT=/media \
    CACHE_DIR=/cache \
    PORT=8080 \
    NODE_ENV=production

EXPOSE 8080
VOLUME ["/cache"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
