# Multi-project analytics collector + private dashboard
FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js dashboard.html ./
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
