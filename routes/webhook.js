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
                const baseUrl = `https://${req.headers.host}`;
                const bindUrl = `${baseUrl}/bind?lineId=${lineUserId}`;
                await replyLineMessage(event.replyToken, `請點擊下方專屬安全連結，前往網頁進行帳號綁定：\n\n🔗 ${bindUrl}`);
            }
            // 💡 升級：處理「待簽核項目」按鈕 -> 輸出左右滑動卡片 (Carousel)
            else if (text === '待簽核項目') {
                try {
                    const [users] = await db.query('SELECT id, role FROM users WHERE line_user_id = ?', [lineUserId]);
                    if (users.length === 0) return await replyLineMessage(event.replyToken, '請先點擊「綁定」帳號喔！');

                    const role = users[0].role;
                    if (role === 'EMPLOYEE') return await replyLineMessage(event.replyToken, '您目前是一般員工，沒有待簽核的權限喔！');

                    const stepMap = { 'MANAGER': 1, '櫃檯主任': 1, 'DIRECTOR': 2, 'CISO': 3, 'PRINCIPAL': 4 }; const targetStep = stepMap[role];

                    // 撈取待簽核資料 (加上 JOIN users 取得申請人姓名，限制最多顯示 10 筆以免超出 LINE 限制)
                    const [forms] = await db.query(`
                        SELECT a.id, f.name, u.name AS applicant_name, a.created_at 
                        FROM applications a 
                        JOIN form_types f ON a.form_type_id = f.id 
                        JOIN users u ON a.user_id = u.id 
                        WHERE a.status = 'PENDING' AND a.current_step = ?
                        ORDER BY a.created_at DESC LIMIT 10
                    `, [targetStep]);

                    if (forms.length === 0) {
                        await replyLineMessage(event.replyToken, '🎉 太棒了！您目前沒有任何待簽核的單據。');
                    } else {
                        // 製作 Carousel 內的泡泡卡片 (Bubbles)
                        const bubbles = forms.map(f => ({
                            type: "bubble",
                            size: "micro",
                            header: {
                                type: "box", layout: "vertical", backgroundColor: "#0F4C81",
                                contents: [{ type: "text", text: "待簽核", color: "#ffffff", weight: "bold", size: "sm" }]
                            },
                            body: {
                                type: "box", layout: "vertical",
                                contents: [
                                    { type: "text", text: f.name, weight: "bold", size: "md", margin: "sm", wrap: true },
                                    { type: "text", text: `申請人：${f.applicant_name}`, size: "xs", color: "#888888", margin: "sm" },
                                    { type: "text", text: `單號：#${f.id}`, size: "xs", color: "#888888" }
                                ]
                            },
                            footer: {
                                type: "box", layout: "vertical", spacing: "sm",
                                contents: [
                                    { type: "button", style: "primary", color: "#38A169", height: "sm", action: { type: "postback", label: "✅ 核准", data: `action=APPROVE&formId=${f.id}` } },
                                    { type: "button", style: "secondary", color: "#E2E8F0", height: "sm", action: { type: "postback", label: "❌ 駁回", data: `action=REJECT&formId=${f.id}` } }
                                ]
                            }
                        }));

                        const flexMsg = {
                            type: "flex",
                            altText: `您有 ${forms.length} 筆待簽核單據`,
                            contents: { type: "carousel", contents: bubbles }
                        };
                        await replyLineMessage(event.replyToken, flexMsg);
                    }
                } catch (e) { console.error(e); }
            }
            // 💡 升級：處理「簽核中項目」按鈕 -> 輸出左右滑動卡片 (Carousel)
            else if (text === '簽核中項目') {
                try {
                    const [users] = await db.query('SELECT id FROM users WHERE line_user_id = ?', [lineUserId]);
                    if (users.length === 0) return await replyLineMessage(event.replyToken, '請先點擊「綁定」帳號喔！');

                    const [forms] = await db.query(`
                        SELECT a.id, f.name, a.current_step 
                        FROM applications a 
                        JOIN form_types f ON a.form_type_id = f.id 
                        WHERE a.status = 'PENDING' AND a.user_id = ?
                        ORDER BY a.created_at DESC LIMIT 10
                    `, [users[0].id]);

                    if (forms.length === 0) {
                        await replyLineMessage(event.replyToken, '您目前沒有正在簽核中的申請單喔！');
                    } else {
                        const stepNames = { 1: '單位主管', 2: '管理部主任', 3: '資安長', 4: '班主任' };

                        const bubbles = forms.map(f => ({
                            type: "bubble",
                            size: "micro",
                            header: {
                                type: "box", layout: "vertical", backgroundColor: "#D69E2E",
                                contents: [{ type: "text", text: "簽核中", color: "#ffffff", weight: "bold", size: "sm" }]
                            },
                            body: {
                                type: "box", layout: "vertical",
                                contents: [
                                    { type: "text", text: f.name, weight: "bold", size: "md", margin: "sm", wrap: true },
                                    { type: "text", text: `單號：#${f.id}`, size: "xs", color: "#888888", margin: "sm" },
                                    { type: "text", text: `卡在：第${f.current_step}關`, size: "xs", color: "#E53E3E", weight: "bold" },
                                    { type: "text", text: `(${stepNames[f.current_step] || '未知'})`, size: "xs", color: "#E53E3E" }
                                ]
                            }
                        }));

                        const flexMsg = {
                            type: "flex",
                            altText: `您有 ${forms.length} 筆簽核中的單據`,
                            contents: { type: "carousel", contents: bubbles }
                        };
                        await replyLineMessage(event.replyToken, flexMsg);
                    }
                } catch (e) { console.error(e); }
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

// 💡 升級：讓 replyLineMessage 支援回覆 Flex Message (多頁卡片)
async function replyLineMessage(replyToken, messageContent) {
    if (!LINE_TOKEN) return;
    const messagesObj = Array.isArray(messageContent) ? messageContent :
        (typeof messageContent === 'string' ? [{ type: 'text', text: messageContent }] : [messageContent]);
    try {
        await axios.post('https://api.line.me/v2/bot/message/reply', {
            replyToken: replyToken,
            messages: messagesObj
        }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` } });
    } catch (err) { console.error('回覆失敗', err.response ? JSON.stringify(err.response.data) : err.message); }
}

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