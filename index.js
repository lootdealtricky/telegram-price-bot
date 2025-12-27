// index.js ki shuruat aise karein
const BOT_TOKEN = process.env.BOT_TOKEN; // Ye safe tarika hai
const bot = new Telegraf(BOT_TOKEN);

const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');

const keywords = ['loot', 'loooot', 'fast'];

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;

    // Keyword Check
    const isLoot = keywords.some(k => text.toLowerCase().includes(k));
    if (!isLoot) return;

    // URL aur Price nikalna (Example: Price: 499)
    const url = text.match(/https?:\/\/[^\s]+/)?.[0];
    const priceMatch = text.match(/Price[:\s]*(\d+)/i);
    
    if (url && priceMatch) {
        const oldPrice = parseInt(priceMatch[1]);
        checkPrice(url, oldPrice, msgId, chatId, text);
    }
});

async function checkPrice(url, oldPrice, msgId, chatId, oldText) {
    const browser = await puppeteer.launch({
        executablePath: '/usr/bin/google-chrome', // Render ke liye zaroori
        args: ['--no-sandbox']
    });

    const timer = setInterval(async () => {
        const page = await browser.newPage();
        try {
            await page.goto(url);
            // Price check karne ka asaan tarika (is selector ko website ke hisab se badalna pad sakta hai)
            const currentPrice = await page.$eval('.a-price-whole', el => parseInt(el.innerText.replace(/\D/g,''))).catch(() => null);
            
            // Agar price 20% badh gaya
            if (currentPrice > oldPrice * 1.20 || !currentPrice) {
                const newText = `${oldText}\n\n⚠️ Price Up ho gaya hai!\n@lootdealtricky bot`;
                await bot.telegram.editMessageText(chatId, msgId, null, newText);
                clearInterval(timer);
                await browser.close();
            }
        } catch (e) { console.log("Checking..."); }
        await page.close();
    }, 60000); // Har 1 minute me check karega
}

bot.launch();
