const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

const db = new Datastore({ filename: 'tasks.db', autoload: true });
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

const triggerKeywords = ['loot', 'pincode', 'reg', 'available', 'grab', 'price', 'deal', 'coupon', 'off', 'voucher', 'flat', 'lowest', 'apply']; 
const exclusionKeywords = ['guide', 'ajiio.in', 'review', 'sale ended'];

const app = express();
app.get('/', (req, res) => res.send('Bot is Running Live!'));
app.listen(process.env.PORT || 10000);

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;
    const lowerText = text.toLowerCase().trim();

    if (exclusionKeywords.some(k => lowerText.includes(k))) return;

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;
    const url = urlMatch[0];

    const hasTrigger = triggerKeywords.some(k => lowerText.includes(k));
    const textWithoutUrl = text.replace(url, '').trim();
    const isOnlyUrl = textWithoutUrl === ""; 
    const isUrlWithNumbers = /\d+/.test(textWithoutUrl); 

    if (hasTrigger || isOnlyUrl || isUrlWithNumbers) {
        console.log(`Tracking started: ${url}`);
        const allNumbers = text.match(/\d+/g);
        let oldPrice = allNumbers ? parseInt(allNumbers[allNumbers.length - 1]) : 0;
        
        // चेक करना कि क्या पोस्ट में कूपन का जिक्र है
        const isCouponPost = lowerText.includes('coupon') || lowerText.includes('voucher');

        const timestamp = Date.now();
        db.insert({ url, oldPrice, msgId, chatId, timestamp, isCouponPost });
        monitorPrice(url, oldPrice, msgId, chatId, timestamp, isCouponPost);
    }
});

async function monitorPrice(url, oldPrice, msgId, chatId, timestamp, isCouponPost) {
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
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

                // 1. प्राइस चेक करना
                const currentPrice = await page.$eval('.a-price-whole, ._30jeq3, ._25b18c, .nx-cp0', el => 
                    parseInt(el.innerText.replace(/\D/g,''))
                ).catch(() => null);

                // 2. स्टॉक चेक करना
                const html = await page.content();
                const outOfStock = /Out of Stock|Currently unavailable|Sold Out/i.test(html);

                // 3. कूपन चेक करना (सिर्फ Amazon/Flipkart के लिए)
                // अगर पोस्ट में कूपन था, तो पेज पर 'Coupon', 'Apply', या 'Off' शब्द ढूंढना
                let couponMissing = false;
                if (isCouponPost) {
                    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
                    const couponKeywordsOnPage = ['coupon', 'voucher', 'apply', 'collect'];
                    const hasCouponOnPage = couponKeywordsOnPage.some(k => pageText.includes(k));
                    if (!hasCouponOnPage) couponMissing = true;
                }

                // Final Logic: स्टॉक खत्म हो OR प्राइस बढ़े OR कूपन गायब हो जाए
                if (outOfStock || (oldPrice > 0 && currentPrice && currentPrice > oldPrice * 1.25) || (isCouponPost && couponMissing)) {
                    await bot.telegram.editMessageText(chatId, msgId, null, `❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`);
                    db.remove({ msgId });
                    await browser.close();
                    return;
                }
            } catch (e) {
                console.log("Check fail, retrying...");
            } finally {
                if (!page.isClosed()) await page.close();
            }
            setTimeout(check, 120000); 
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }
}

bot.launch();
