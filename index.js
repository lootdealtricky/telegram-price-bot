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
    const hasTriggerKeyword = triggerKeywords.some(k => lowerText.includes(k));
    const hasNumbers = /\d+/.test(text);

    if (hasTriggerKeyword || hasNumbers || text.replace(url, '').trim() === "") {
        console.log(`🎯 Valid Task: ${url}`);
        
        const allNumbers = text.match(/\b\d{2,5}\b/g); 
        let oldPrice = allNumbers ? Math.min(...allNumbers.map(Number)) : 0;
        
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
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote']
        });

        const check = async () => {
            if (Date.now() - timestamp > 86400000) {
                db.remove({ msgId });
                if (browser) await browser.close();
                return;
            }

            const page = await browser.newPage();
            try {
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                
                // Bypass Redirections
                await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
                const finalUrl = page.url();

                // Masterlink Check (Link DNA)
                const isAmazonProduct = finalUrl.includes('/dp/') || finalUrl.includes('/gp/product/');
                const isFlipkartProduct = finalUrl.includes('/p/') || finalUrl.includes('pid=');

                if ((finalUrl.includes('amazon.in') && !isAmazonProduct) || (finalUrl.includes('flipkart.com') && !isFlipkartProduct)) {
                    console.log(`⏭️ Masterlink Skipped: ${finalUrl}`);
                    db.remove({ msgId });
                    await browser.close(); return;
                }

                const pageData = await page.evaluate(() => {
                    const priceSelectors = ['.a-price-whole', '.priceToPay', '.a-offscreen', '._30jeq3', '._25b18c', '.pdp-price', '.price'];
                    let foundPrice = null;
                    for (let s of priceSelectors) {
                        const els = document.querySelectorAll(s);
                        for (let el of els) {
                            let p = parseInt(el.innerText.replace(/\D/g, ''));
                            if (p > 5) { foundPrice = p; break; }
                        }
                        if (foundPrice) break;
                    }
                    const isOutOfStock = /Out of Stock|Currently unavailable|Sold Out|stokta yok|Abhi upalabdh nahin/i.test(document.body.innerText);
                    const hasCouponOnPage = /coupon|voucher|apply|promo|collect/i.test(document.body.innerText);
                    return { foundPrice, isOutOfStock, hasCouponOnPage };
                });

                console.log(`📊 Stats: ${finalUrl.substring(0, 40)}... | Post Price: ${oldPrice} | Live: ${pageData.foundPrice}`);

                const isPriceIncreased = (oldPrice > 0 && pageData.foundPrice && pageData.foundPrice >= (oldPrice * 1.30)) && !pageData.hasCouponOnPage;
                let couponMissing = isCouponPost && !pageData.hasCouponOnPage;

                if (pageData.isOutOfStock || isPriceIncreased || couponMissing) {
                    const updatedText = `${originalText}\n\n❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                    try {
                        if (isMedia) {
                            await bot.telegram.editMessageCaption(chatId, msgId, null, updatedText);
                        } else {
                            await bot.telegram.editMessageText(chatId, msgId, null, updatedText);
                        }
                    } catch (e) { console.log("Edit Error:", e.message); }
                    db.remove({ msgId });
                    await browser.close();
                    return;
                }
            } catch (e) {
                console.log(`⚠️ Retry for ${url}: ${e.message}`);
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

