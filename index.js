const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

const db = new Datastore({ filename: 'tasks.db', autoload: true });
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

const triggerKeywords = ['loot', 'deal', 'price', 'coupon', 'off', 'apply', 'lowest', 'grab']; 
const exclusionKeywords = ['guide', 'review', 'sale ended'];

const app = express();
app.get('/', (req, res) => res.send('Bot is Running Live!'));
app.listen(process.env.PORT || 10000);

bot.launch().then(() => console.log("✅ BOT CONNECTED & READY!"));

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || ctx.channelPost.caption || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;
    const lowerText = text.toLowerCase().trim();

    if (exclusionKeywords.some(k => lowerText.includes(k))) return;

    const urlMatches = text.match(/https?:\/\/[^\s]+/g);
    if (!urlMatches || urlMatches.length > 1) return; 

    const url = urlMatches[0];
    const hasNumbers = /\d+/.test(text);

    if (triggerKeywords.some(k => lowerText.includes(k)) || hasNumbers || text.replace(url, '').trim() === "") {
        console.log(`🎯 New Task Received: ${url}`);
        
        // Smart Price Picking (Aakhri chhota number jo PIN code na ho)
        const allNumbers = text.match(/\b\d{2,5}\b/g); 
        let oldPrice = allNumbers ? Math.min(...allNumbers.map(Number)) : 0;
        
        const isMedia = !!(ctx.channelPost.photo || ctx.channelPost.video || ctx.channelPost.document);

        db.insert({ url, oldPrice, msgId, chatId, originalText: text, isMedia, timestamp: Date.now() });
        monitorPrice(url, oldPrice, msgId, chatId, text, isMedia, Date.now());
    }
});

async function monitorPrice(url, oldPrice, msgId, chatId, originalText, isMedia, timestamp) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote']
        });

        const check = async () => {
            if (Date.now() - timestamp > 86400000) { // 24 Hours limit
                db.remove({ msgId });
                if (browser) await browser.close();
                return;
            }

            const page = await browser.newPage();
            try {
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                
                console.log(`🔗 Navigating: ${url}`);
                // networkidle0 taaki redirections poore ho sakein
                await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });

                // Extra wait for affiliate links/redirectors (like lootdealtricky or fktr)
                await new Promise(r => setTimeout(r, 15000));

                const finalUrl = page.url();
                console.log(`✅ Final Landing URL: ${finalUrl}`);

                const pageData = await page.evaluate(() => {
                    const priceSelectors = [
                        '.a-price-whole', '.priceToPay', '.a-offscreen', 
                        '._30jeq3', '._25b18c', '.pdp-price', '.pdp-discount-price', 
                        '.price-main-price', '.css-1j6m64', '.pdp-m-price'
                    ];
                    let foundPrice = null;
                    for (let s of priceSelectors) {
                        const els = document.querySelectorAll(s);
                        for (let el of els) {
                            let p = parseInt(el.innerText.replace(/\D/g, ''));
                            if (p > 5) { foundPrice = p; break; }
                        }
                        if (foundPrice) break;
                    }
                    const isOutOfStock = /Out of Stock|Currently unavailable|Sold Out|stokta yok|Abhi upalabdh nahin|not available/i.test(document.body.innerText);
                    return { foundPrice, isOutOfStock };
                });

                console.log(`📊 Stats | Price: ${pageData.foundPrice} | OOS: ${pageData.isOutOfStock}`);

                // 35% Price increase margin
                const isPriceIncreased = (oldPrice > 0 && pageData.foundPrice && pageData.foundPrice >= (oldPrice * 1.35));

                if (pageData.isOutOfStock || isPriceIncreased) {
                    console.log("🚨 DEAL OVER! Updating Telegram...");
                    const updatedText = `${originalText}\n\n❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                    
                    try {
                        if (isMedia) {
                            await bot.telegram.editMessageCaption(chatId, msgId, null, updatedText);
                        } else {
                            await bot.telegram.editMessageText(chatId, msgId, null, updatedText);
                        }
                    } catch (e) { console.log("Edit Fail:", e.message); }
                    
                    db.remove({ msgId });
                    await browser.close();
                    return;
                }
            } catch (e) {
                console.log(`⚠️ Check Failed: ${e.message}`);
            } finally {
                if (!page.isClosed()) await page.close();
            }
            setTimeout(check, 300000); // Check every 5 mins
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }
}

