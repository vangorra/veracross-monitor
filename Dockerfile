FROM node:8.12.0-alpine

COPY . /app

RUN cd /app && \
    npm install && \
    SKIP_START=1 node /app/index.js

ENTRYPOINT node /app/index.js
