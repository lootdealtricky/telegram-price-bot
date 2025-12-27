# Pehle se Chrome install wala image use karein
FROM ghcr.io/puppeteer/puppeteer:latest

# Bot ke folder mein jayein
WORKDIR /usr/src/app

# Dependencies copy karein aur install karein
COPY package*.json ./
RUN npm install

# Baaki code copy karein
COPY . .

# Bot ko start karein
CMD [ "node", "index.js" ]
