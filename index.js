const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

const db = new Datastore({ filename: 'tasks.db', autoload: true });
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

const triggerKeywords = ['loot', 'pincode', 'available', 'grab', 'price', 'deal', 'coupon', 'off', 'voucher', 'flat', 'lowest', 'apply', 'discount', 'free']; 
const exclusionKeywords = ['guide', 'ajiio.in', 'review', 'sale ended', 'Lootdealtricky.in/url/channels'];

const app = express();
app.get('/', (req, res) => res.send('Bot is Running Live!'));
app.listen(process.env.PORT || 10000);

bot.launch().catch(err => console.log("Bot Launch Error:", err.message));

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || ctx.channelPost.caption || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;
    const lowerText = text.toLowerCase().trim();

    if (exclusionKeywords.some(k => lowerText.includes(k))) return;

    const urlMatches = text.match(/https?:\/\/[^\s]+/g);
    if (!urlMatches || urlMatches.length > 1) return; 

    const url = urlMatches[0];
    const hasTriggerKeyword = triggerKeywords.some(k => lowerText.includes(k));
    const hasNumbers = /\d+/.test(text);

    if (hasTriggerKeyword || hasNumbers || text.replace(url, '').trim() === "") {
        console.log(`🎯 Valid Task: ${url}`);
        
        // --- पुराना प्राइस निकालने का बेहतर तरीका ---
        const allNumbers = text.match(/\b\d{2,5}\b/g); 
        let oldPrice = 0;
        if (allNumbers) {
            const filtered = allNumbers.map(Number).filter(n => n > 25); // छोटे नंबर्स (जैसे 10% off) को इग्नोर करें
            if (filtered.length > 0) oldPrice = Math.min(...filtered);
        }
        
        const isCouponPost = lowerText.includes('coupon') || lowerText.includes('apply');
        const isMedia = !!(ctx.channelPost.photo || ctx.channelPost.video || ctx.channelPost.document);

        db.insert({ url, oldPrice, msgId, chatId, originalText: text, isMedia, timestamp: Date.now(), isCouponPost });
        monitorPrice(url, oldPrice, msgId, chatId, text, isMedia, Date.now(), isCouponPost);
    }
});

async function monitorPrice(url, oldPrice, msgId, chatId, originalText, isMedia, timestamp, isCouponPost) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
        });

        const check = async () => {
            // अगर ब्राउज़र बंद हो चुका है तो लूप रोक दें
            if (!browser) return;

            if (Date.now() - timestamp > 86400000) {
                db.remove({ msgId }, {}, () => {});
                await browser.close().catch(() => {});
                browser = null;
                return;
            }

            let page;
            try {
                page = await browser.newPage();
                await page.setViewport({ width: 375, height: 667, isMobile: true });
                await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1');
                
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

                // Amazon/Flipkart redirection wait
                let finalUrl = page.url();
                if (finalUrl.includes('amzn.to') || finalUrl.includes('fkrt') || finalUrl.includes('bit.ly')) {
                    await new Promise(r => setTimeout(r, 6000));
                }

                const pageData = await page.evaluate(() => {
                    let foundPrice = null;
                    const selectors = [
                        '.a-price-whole', '#corePrice_desktop .a-offscreen', // Amazon
                        'span.pdp-discount-price', 'span.pdp-price', // Myntra
                        'div[class*="_30jeq3"]', '.nx-cp', 'div[class*="_16Jk6d"]' // Flipkart
                    ];

                    for (let s of selectors) {
                        const el = document.querySelector(s);
                        if (el && el.innerText) {
                            let p = parseInt(el.innerText.replace(/[^\d]/g, ''));
                            if (p > 10) { foundPrice = p; break; }
                        }
                    }

                    const bodyText = document.body.innerText;
                    const isOutOfStock = /Out of Stock|Currently unavailable|Sold Out|Abhi upalabdh nahin/i.test(bodyText);
                    const hasCouponOnPage = /coupon|voucher|apply/i.test(bodyText);
                    
                    return { foundPrice, isOutOfStock, hasCouponOnPage };
                });

                console.log(`📊 Stats [${msgId}]: Price: ${pageData.foundPrice} | OOS: ${pageData.isOutOfStock}`);

                // --- फिक्स किया हुआ Logic ---
                if (pageData.foundPrice || pageData.isOutOfStock) {
                    const isPriceIncreased = (oldPrice > 0 && pageData.foundPrice >= (oldPrice * 1.40)); // 40% की वृद्धि
                    const couponMissing = isCouponPost && !pageData.hasCouponOnPage;

                    if (pageData.isOutOfStock || isPriceIncreased || (isCouponPost && couponMissing)) {
                        console.log(`🚨 DEAL OVER for ${msgId}`);
                        const updatedText = `${originalText}\n\n❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                        
                        try {
                            if (isMedia) { await bot.telegram.editMessageCaption(chatId, msgId, null, updatedText); }
                            else { await bot.telegram.editMessageText(chatId, msgId, null, updatedText); }
                        } catch (e) { console.log("Edit Error:", e.message); }
                        
                        db.remove({ msgId }, {}, () => {});
                        const b = browser;
                        browser = null; // ताकि लूप और finally इसे टच न करें
                        await b.close().catch(() => {});
                        return;
                    }
                }
            } catch (e) {
                console.log(`⚠️ Log Error [${msgId}]: ${e.message}`);
            } finally {
                // यहाँ क्रैश से बचाव (अगर ब्राउज़र अभी भी है, तभी पेज बंद करें)
                if (page && browser) {
                    await page.close().catch(() => {});
                }
            }
            
            if (browser) setTimeout(check, 180000); 
        };
        
        check();
    } catch (e) {
        if (browser) await browser.close().catch(() => {});
        browser = null;
    }
}
