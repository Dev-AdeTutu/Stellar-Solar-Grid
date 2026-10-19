# --- Builder stage ---
FROM node:20-alpine AS builder

WORKDIR /app

ARG VITE_CONTRACT_ID
ARG VITE_BACKEND_URL
ARG VITE_RPC_URL
ARG VITE_NETWORK_PASSPHRASE

ENV VITE_CONTRACT_ID=$VITE_CONTRACT_ID
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_RPC_URL=$VITE_RPC_URL
ENV VITE_NETWORK_PASSPHRASE=$VITE_NETWORK_PASSPHRASE

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Runner stage ---
FROM nginx:alpine AS runner

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
