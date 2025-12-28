const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

const db = new Datastore({ filename: 'tasks.db', autoload: true });
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

const triggerKeywords = ['loot', 'pincode', 'reg', 'available', 'grab', 'price', 'deal', 'coupon', 'off', 'voucher', 'flat', 'lowest', 'apply', 'discount', 'free']; 
const exclusionKeywords = ['guide', 'ajiio.in', 'review', 'sale ended'];

const app = express();
app.get('/', (req, res) => res.send('Bot is Running Live!'));
app.listen(process.env.PORT || 10000);

bot.launch().then(() => console.log("✅ BOT CONNECTED TO TELEGRAM!"));

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
    const isOnlyUrl = text.replace(url, '').trim() === "";
    
    const textWithoutUrl = text.replace(url, '').replace(/[^\d]/g, '').trim();
    const isOnlyNumbersAndUrl = textWithoutUrl.length > 0 && text.replace(url, '').replace(/[\d\s\W]/g, '').length === 0;

    if (hasTriggerKeyword || isOnlyUrl || isOnlyNumbersAndUrl) {
        console.log(`🎯 Validating URL Structure: ${url}`);
        // मॉनिटरिंग शुरू करें, हम ब्राउज़र के अंदर ही चेक कर लेंगे कि यह मास्टरलिंक तो नहीं
        monitorPrice(url, text, msgId, chatId, text, Date.now());
    }
});

async function monitorPrice(url, originalText, msgId, chatId, text, timestamp) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote']
        });

        const check = async () => {
            const page = await browser.newPage();
            try {
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
                
                // 1. Unshorten/Navigate
                const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                const finalUrl = page.url(); // यहाँ हमें असली बड़ा लिंक मिलेगा

                // 2. Masterlink Detection (ASIN check for Amazon)
                // Amazon का सिंगल प्रोडक्ट लिंक हमेशा /dp/ या /gp/product/ के बाद 10 अक्षरों का ASIN रखता है
                const isAmazonProduct = finalUrl.includes('/dp/') || finalUrl.includes('/gp/product/');
                const isFlipkartProduct = finalUrl.includes('/p/') || finalUrl.includes('pid=');

                if (finalUrl.includes('amazon.in') && !isAmazonProduct) {
                    console.log(`⏭️ Skipping: Amazon Masterlink detected (${finalUrl})`);
                    await browser.close(); return;
                }
                
                if (finalUrl.includes('flipkart.com') && !isFlipkartProduct) {
                    console.log(`⏭️ Skipping: Flipkart Masterlink detected (${finalUrl})`);
                    await browser.close(); return;
                }

                // --- यहाँ से पुराना प्राइस और स्टॉक चेक लॉजिक ---
                const pageData = await page.evaluate(() => {
                    const priceSelectors = ['.a-price-whole', '._30jeq3', '._25b18c', '.pdp-price'];
                    let foundPrice = null;
                    for (let s of priceSelectors) {
                        const el = document.querySelector(s);
                        if (el && el.innerText) {
                            let p = parseInt(el.innerText.replace(/\D/g, ''));
                            if (p > 0) { foundPrice = p; break; }
                        }
                    }
                    const isOutOfStock = /Out of Stock|Currently unavailable|Sold Out/i.test(document.body.innerText);
                    return { foundPrice, isOutOfStock };
                });

                // Price logic (as discussed before)
                const allNumbers = text.match(/\b\d{1,5}\b/g); 
                let oldPrice = allNumbers ? parseInt(allNumbers[allNumbers.length - 1]) : 0;

                if (pageData.isOutOfStock || (oldPrice > 0 && pageData.foundPrice >= (oldPrice * 1.25))) {
                    const updatedText = `${originalText}\n\n❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                    await bot.telegram.editMessageText(chatId, msgId, null, updatedText).catch(() => 
                          bot.telegram.editMessageCaption(chatId, msgId, null, updatedText).catch(() => null)
                    );
                    db.remove({ msgId });
                    await browser.close();
                    return;
                }

            } catch (e) {
                console.log(`⚠️ Check Error: ${e.message}`);
            } finally {
                if (!page.isClosed()) await page.close();
            }
            setTimeout(check, 180000); 
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }
}
