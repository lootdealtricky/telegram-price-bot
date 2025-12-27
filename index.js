const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);
const keywords = ['loot', 'loooot', 'fast'];

console.log("Starting Bot...");

bot.on('channel_post', async (ctx) => {
    console.log("--- New Post Received ---");
    const text = ctx.channelPost.text || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;

    // 1. Keyword Check
    const isLoot = keywords.some(k => text.toLowerCase().includes(k));
    if (!isLoot) return;

    // 2. सुधरा हुआ URL और Price निकालने का तरीका
    // यह लिंक को ढूंढेगा (amzn.to या amazon.in दोनों)
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    
    // यह किसी भी 2 से 6 डिजिट के नंबर को Price मान लेगा जो पोस्ट के आखिर में या कहीं भी हो
    const priceMatch = text.match(/(?:Price[:\s]*|#Flipkart\s*|#Amazon\s*)?(\d{2,6})/i);
    
    if (urlMatch && priceMatch) {
        const oldPrice = parseInt(priceMatch[1]);
        const url = urlMatch[0];
        console.log(`✅ Monitoring: ${url} | Price Found: ${oldPrice}`);
        monitorPrice(url, oldPrice, msgId, chatId, text);
    } else {
        console.log("❌ Error: Could not extract Price or URL clearly.");
    }
});

async function monitorPrice(url, oldPrice, msgId, chatId, oldText) {
    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: '/usr/bin/google-chrome',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process']
        });

        const check = async () => {
            const page = await browser.newPage();
            try {
                // User Agent ताकि Amazon ब्लॉक न करे
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                
                // प्राइस निकालने की कोशिश (Amazon/Flipkart दोनों के लिए)
                const currentPrice = await page.evaluate(() => {
                    const el = document.querySelector('.a-price-whole') || document.querySelector('._30jeq3');
                    return el ? parseInt(el.innerText.replace(/\D/g, '')) : null;
                });

                const outOfStock = await page.content().then(html => 
                    html.includes("Out of Stock") || html.includes("Currently unavailable") || html.includes("Sold Out")
                );

                console.log(`Checking ${url} | Current: ${currentPrice} | Target: ${oldPrice}`);

                if (outOfStock || (currentPrice && currentPrice > oldPrice * 1.15)) {
                    let reason = outOfStock ? "OUT OF STOCK" : "PRICE UP";
                    const newText = `${oldText}\n\n⚠️ ${reason} हो गया है!`;
                    
                    await bot.telegram.editMessageText(chatId, msgId, null, newText);
                    console.log("✅ Message Edited Successfully.");
                    await browser.close();
                    return; 
                }
            } catch (err) {
                console.log("Error during check, retrying...");
            } finally {
                await page.close();
            }
            setTimeout(check, 180000); // 3 मिनट में चेक करें
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
        console.error("Browser Error:", e);
    }
}

bot.launch();

// Render Server
const app = express();
app.get('/', (req, res) => res.send('Bot is Running!'));
app.listen(process.env.PORT || 10000);
