const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const db = require('../db');
const router = express.Router();

const LINE_TOKEN = process.env.LINE_TOKEN;
const LINE_SECRET = process.env.LINE_SECRET;

router.post('/line', async (req, res) => {
    if (!LINE_SECRET) return res.status(403).send('No LINE_SECRET');

    const signature = crypto.createHmac('SHA256', LINE_SECRET).update(JSON.stringify(req.body)).digest('base64');
    if (req.headers['x-line-signature'] !== signature) return res.status(403).send('Unauthorized');

    res.sendStatus(200);

    const events = req.body.events;
    if (!events || events.length === 0) return;

    for (let event of events) {
        const lineUserId = event.source.userId;

        // 🟢 處理「文字訊息」
        if (event.type === 'message' && event.message.type === 'text') {
            const text = event.message.text.trim();

            if (text.startsWith('綁定')) {
                // 💡 升級：自動抓取目前的 ngrok 網址，並產生帶有 lineId 的專屬安全連結
                const baseUrl = `https://${req.headers.host}`;
                const bindUrl = `${baseUrl}/bind?lineId=${lineUserId}`;

                await replyLineMessage(event.replyToken, `請點擊下方專屬安全連結，前往網頁進行帳號綁定（密碼將加密傳輸）：\n\n🔗 ${bindUrl}`);
            }
        }
        // 🔵 處理「按鈕點擊」(Postback)
        else if (event.type === 'postback') {
            const postbackData = new URLSearchParams(event.postback.data);
            const action = postbackData.get('action');
            const formId = postbackData.get('formId');

            try {
                const [users] = await db.query('SELECT id, name FROM users WHERE line_user_id = ?', [lineUserId]);
                if (users.length === 0) return await replyLineMessage(event.replyToken, '❌ 找不到您的帳號，請先輸入「綁定」。');
                const approver = users[0];

                const [apps] = await db.query('SELECT current_step, status, user_id FROM applications WHERE id = ?', [formId]);
                if (apps.length === 0) return await replyLineMessage(event.replyToken, '❌ 找不到該表單。');

                const form = apps[0];
                if (form.status !== 'PENDING') return await replyLineMessage(event.replyToken, `⚠️ 單號 #${formId} 已經處理完畢囉！`);

                await db.query(
                    'INSERT INTO approval_logs (application_id, approver_id, step_number, action, comment) VALUES (?, ?, ?, ?, ?)',
                    [formId, approver.id, form.current_step, action, '來自 LINE 的快速簽核']
                );

                if (action === 'REJECT') {
                    await db.query('UPDATE applications SET status = "REJECTED" WHERE id = ?', [formId]);
                    await replyLineMessage(event.replyToken, `✅ 您已成功「駁回」單號 #${formId}。`);

                    const [applicant] = await db.query('SELECT line_user_id FROM users WHERE id = ?', [form.user_id]);
                    if (applicant[0] && applicant[0].line_user_id) {
                        await sendLineMessage(applicant[0].line_user_id, `⚠️ 您的申請單 #${formId} 已被 ${approver.name} 駁回。`);
                    }
                } else if (action === 'APPROVE') {
                    if (form.current_step < 4) {
                        await db.query('UPDATE applications SET current_step = current_step + 1 WHERE id = ?', [formId]);
                        await replyLineMessage(event.replyToken, `✅ 您已「核准」單號 #${formId}，表單已轉交下一關主管。`);
                    } else {
                        await db.query('UPDATE applications SET status = "APPROVED" WHERE id = ?', [formId]);
                        await replyLineMessage(event.replyToken, `✅ 您已「核准」單號 #${formId}，流程全數完成！`);

                        const [applicant] = await db.query('SELECT line_user_id FROM users WHERE id = ?', [form.user_id]);
                        if (applicant[0] && applicant[0].line_user_id) {
                            await sendLineMessage(applicant[0].line_user_id, `🎉 恭喜！您的申請單 #${formId} 已全數簽核通過！`);
                        }
                    }
                }
            } catch (err) {
                await replyLineMessage(event.replyToken, '系統錯誤，無法完成簽核。');
            }
        }
    }
});

async function replyLineMessage(replyToken, textMessage) {
    if (!LINE_TOKEN) return;
    try {
        await axios.post('https://api.line.me/v2/bot/message/reply', {
            replyToken: replyToken,
            messages: [{ type: 'text', text: textMessage }]
        }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` } });
    } catch (err) { console.error('回覆失敗'); }
}

// 💡 升級：現在支援傳入 Array，允許一次發送「文字 + 按鈕」兩則對話！
async function sendLineMessage(lineUserId, messageContent) {
    if (!lineUserId || !LINE_TOKEN) return;

    const messagesObj = Array.isArray(messageContent) ? messageContent :
        (typeof messageContent === 'string' ? [{ type: 'text', text: messageContent }] : [messageContent]);
    try {
        await axios.post('https://api.line.me/v2/bot/message/push', {
            to: lineUserId,
            messages: messagesObj
        }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` } });
    } catch (err) { console.error("推播失敗", err.response ? err.response.data : err.message); }
}

module.exports = { router, sendLineMessage };