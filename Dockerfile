FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Build React UI frontend static files
RUN npm run build

EXPOSE 5000

CMD ["npm", "start"]
