# Node.js का इमेज इस्तेमाल करें
FROM ghcr.io/puppeteer/puppeteer:latest

# Bot का फोल्डर बनाएँ
WORKDIR /app

# Permissions सेट करें
USER root

# Files कॉपी करें
COPY package*.json ./
RUN npm install

COPY . .

# Bot स्टार्ट करें
CMD ["node", "index.js"]
