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
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', 
                '--single-process', 
                '--no-zygote',
                '--disable-blink-features=AutomationControlled' // Myntra/Flipkart bypass के लिए
            ]
        });

        const check = async () => {
            if (Date.now() - timestamp > 86400000) {
                db.remove({ msgId });
                if (browser) await browser.close();
                return;
            }

            const page = await browser.newPage();
            try {
                // असली ब्राउज़र जैसा दिखने के लिए
                await page.setViewport({ width: 1280, height: 800 });
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                
                console.log(`🔗 Navigating: ${url}`);
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

                // --- विशेष बदलाव: Lootdealtricky और अन्य Redirectors के लिए ---
                const currentUrl = page.url();
                if (currentUrl.includes('lootdealtricky') || currentUrl.includes('linkredirect') || currentUrl.includes('fktr.in')) {
                    console.log("👆 Attempting to click 'Go to Store' or Waiting for Redirect...");
                    
                    // अगर वहां कोई बटन है तो उसे क्लिक करें
                    await page.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('a, button'));
                        const target = buttons.find(b => 
                            /Go to Store|Visit Retailer|Get Deal|Continue/i.test(b.innerText)
                        );
                        if (target) target.click();
                    });

                    // रीडायरेक्ट होने के लिए 15 सेकंड का पक्का इंतज़ार
                    await new Promise(r => setTimeout(r, 15000));
                }

                const finalUrl = page.url();
                console.log(`✅ Final Landing URL: ${finalUrl.substring(0, 50)}...`);

                // Masterlink Check
                const isAmazonProduct = finalUrl.includes('/dp/') || finalUrl.includes('/gp/product/');
                const isFlipkartProduct = finalUrl.includes('/p/') || finalUrl.includes('pid=') || finalUrl.includes('/dm/p/');
                const isMyntraProduct = finalUrl.includes('/buy');

                if ((finalUrl.includes('amazon.in') && !isAmazonProduct) || 
                    (finalUrl.includes('flipkart.com') && !isFlipkartProduct)) {
                    console.log(`⏭️ Masterlink Skipped`);
                    db.remove({ msgId });
                    if (browser) await browser.close();
                    return;
                }

                const pageData = await page.evaluate(() => {
                    const priceSelectors = [
                        '.a-price-whole',          // Amazon Main
                        '.priceToPay',             // Amazon New
                        '.a-size-medium.a-color-price', // Amazon Older
                        '._30jeq3',                // Flipkart
                        '.pdp-price',              // Myntra
                        '.pdp-discount-price',     // Myntra 2
                        '#priceblock_ourprice',    // Amazon Old
                        '#priceblock_dealprice'    // Amazon Deal
                    ];
                    
                    let foundPrice = null;
                    
                    // Strategy 1: Selectors से ढूंढना
                    for (let s of priceSelectors) {
                        const el = document.querySelector(s);
                        if (el && el.innerText) {
                            let p = parseInt(el.innerText.replace(/\D/g, ''));
                            if (p > 5) { foundPrice = p; break; }
                        }
                    }

                    // Strategy 2: अगर Selectors काम न करें (Amazon Special)
                    if (!foundPrice) {
                        const whole = document.querySelector('.a-price-whole');
                        const fraction = document.querySelector('.a-price-fraction');
                        if (whole) {
                            foundPrice = parseInt(whole.innerText.replace(/\D/g, ''));
                        }
                    }

                    const bodyText = document.body.innerText;
                    const isOutOfStock = /Out of Stock|Currently unavailable|Sold Out|Abhi upalabdh nahin|not available/i.test(bodyText);
                    const hasCouponOnPage = /coupon|voucher|apply|promo|collect/i.test(bodyText);
                    
                    return { foundPrice, isOutOfStock, hasCouponOnPage };
                });

                console.log(`📊 Stats: Price Found: ${pageData.foundPrice} | OOS: ${pageData.isOutOfStock}`);

                const isPriceIncreased = (oldPrice > 0 && pageData.foundPrice && pageData.foundPrice >= (oldPrice * 1.35)) && !pageData.hasCouponOnPage;
                let couponMissing = isCouponPost && !pageData.hasCouponOnPage;

                if (pageData.isOutOfStock || isPriceIncreased || (isCouponPost && couponMissing && pageData.foundPrice)) {
                    console.log("🚨 DEAL OVER! Updating Message...");
                    const updatedText = `${originalText}\n\n❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                    
                    try {
                        if (isMedia) {
                            await bot.telegram.editMessageCaption(chatId, msgId, null, updatedText);
                        } else {
                            await bot.telegram.editMessageText(chatId, msgId, null, updatedText);
                        }
                    } catch (e) { console.log("Edit Error:", e.message); }
                    
                    db.remove({ msgId });
                    if (browser) await browser.close();
                    return;
                }
            } catch (e) {
                console.log(`⚠️ Retry for URL: ${e.message}`);
            } finally {
                if (!page.isClosed()) await page.close();
            }
            setTimeout(check, 200000); // 2 मिनट बाद दोबारा चेक
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }
}

