const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const db = require('../db');
const router = express.Router();

const LINE_TOKEN = process.env.LINE_TOKEN;
const LINE_SECRET = process.env.LINE_SECRET;

// 處理 LINE Webhook 請求
router.post('/line', async (req, res) => {
    if (!LINE_SECRET) return res.status(403).send('缺少 LINE_SECRET 設定');

    // 驗證 LINE 數位簽章
    const signature = crypto.createHmac('SHA256', LINE_SECRET).update(JSON.stringify(req.body)).digest('base64');
    if (req.headers['x-line-signature'] !== signature) return res.status(403).send('Unauthorized');

    res.sendStatus(200);

    const events = req.body.events;
    if (!events || events.length === 0) return;

    for (let event of events) {
        const lineUserId = event.source.userId;

        // 處理使用者傳送之文字訊息
        if (event.type === 'message' && event.message.type === 'text') {
            const text = event.message.text.trim();

            if (text.startsWith('綁定')) {
                const baseUrl = `https://${req.headers.host}`;
                const bindUrl = `${baseUrl}/bind?lineId=${lineUserId}`;
                await replyLineMessage(event.replyToken, `請點擊下方專屬安全連結，前往網頁進行帳號綁定：\n\n🔗 ${bindUrl}`);
            }
            else if (text === '待簽核項目') {
                try {
                    const [users] = await db.query('SELECT role, name FROM users WHERE line_user_id = ?', [lineUserId]);
                    if (users.length === 0) {
                        await replyLineMessage(event.replyToken, '系統查無綁定紀錄。請輸入「綁定」進行帳號連結。');
                        return;
                    }

                    const user = users[0];
                    const stepMap = { 'MANAGER': 1, '櫃檯主任': 1, 'DIRECTOR': 2, 'CISO': 3, 'PRINCIPAL': 4 };
                    const targetStep = stepMap[user.role];

                    if (!targetStep) {
                        await replyLineMessage(event.replyToken, '您目前的帳號權限無簽核需求。');
                        return;
                    }

                    const [forms] = await db.query(`
                        SELECT a.id, f.name AS form_name, u.name AS applicant 
                        FROM applications a
                        JOIN form_types f ON a.form_type_id = f.id
                        JOIN users u ON a.user_id = u.id
                        WHERE a.status = 'PENDING' AND a.current_step = ?
                    `, [targetStep]);

                    if (forms.length === 0) {
                        await replyLineMessage(event.replyToken, '您目前沒有任何待簽核的單據。');
                    } else {
                        let msg = `待簽核項目共 ${forms.length} 筆：\n`;
                        forms.forEach(f => {
                            msg += `\n單號 #${f.id} - ${f.applicant} (${f.form_name})`;
                        });
                        msg += `\n\n請登入系統大廳進行詳細檢閱與簽核。`;
                        await replyLineMessage(event.replyToken, msg);
                    }
                } catch (err) {
                    console.error(err);
                    await replyLineMessage(event.replyToken, '系統連線異常，無法讀取待簽核資料。');
                }
            }
        }

        // 處理 LINE Flex Message 按鈕回傳動作 (Postback)
        else if (event.type === 'postback') {
            const data = event.postback.data;
            const params = new URLSearchParams(data);
            const action = params.get('action');
            const formId = params.get('formId');

            try {
                const [users] = await db.query('SELECT id, role FROM users WHERE line_user_id = ?', [lineUserId]);
                if (users.length === 0) {
                    await replyLineMessage(event.replyToken, '此帳號尚未綁定系統，無法執行簽核。');
                    return;
                }
                const approverId = users[0].id;

                const [apps] = await db.query(`
                    SELECT a.current_step, a.form_type_id, u.line_user_id AS applicant_line_id, f.name AS form_name
                    FROM applications a
                    JOIN users u ON a.user_id = u.id
                    JOIN form_types f ON a.form_type_id = f.id
                    WHERE a.id = ?
                `, [formId]);

                if (apps.length === 0) {
                    await replyLineMessage(event.replyToken, `單號 #${formId} 查無此單據或已刪除。`);
                    return;
                }

                const { current_step: currentStep, form_type_id: formTypeId, applicant_line_id: applicantLineId, form_name: formName } = apps[0];
                const comment = "透過 LINE 快速審核";

                await db.query(
                    'INSERT INTO approval_logs (application_id, approver_id, step_number, action, comment) VALUES (?, ?, ?, ?, ?)',
                    [formId, approverId, currentStep, action, comment]
                );

                if (action === 'REJECT') {
                    await db.query('UPDATE applications SET status = "REJECTED" WHERE id = ?', [formId]);
                    if (applicantLineId) {
                        await sendLineMessage(applicantLineId, `【簽核通知】\n您的「${formName}」 (單號 #${formId}) 已遭到主管駁回。`);
                    }
                    await replyLineMessage(event.replyToken, `已成功駁回單號 #${formId}。`);
                } else if (action === 'APPROVE') {

                    // 動態判斷下一關卡邏輯
                    let nextStep = currentStep;
                    let isFinal = false;

                    if (formTypeId === 7) {
                        if (currentStep === 1) nextStep = 2;
                        else if (currentStep === 2) nextStep = 3;
                        else if (currentStep === 3) isFinal = true;
                    } else if (formTypeId === 3) {
                        if (currentStep === 1) nextStep = 2;
                        else if (currentStep === 2) nextStep = 3;
                        else if (currentStep === 3) nextStep = 4;
                        else if (currentStep === 4) isFinal = true;
                    } else {
                        if (currentStep === 1) nextStep = 2;
                        else if (currentStep === 2) nextStep = 4;
                        else if (currentStep === 4) isFinal = true;
                    }

                    if (isFinal) {
                        await db.query('UPDATE applications SET status = "APPROVED" WHERE id = ?', [formId]);
                        if (applicantLineId) {
                            await sendLineMessage(applicantLineId, `【簽核通知】\n恭喜！您的「${formName}」 (單號 #${formId}) 已完成最終決行並結案。`);
                        }
                        await replyLineMessage(event.replyToken, `單號 #${formId} 已完成最終決行並結案。`);
                    } else {
                        await db.query('UPDATE applications SET current_step = ? WHERE id = ?', [nextStep, formId]);
                        if (applicantLineId) {
                            await sendLineMessage(applicantLineId, `【簽核通知】\n您的「${formName}」 (單號 #${formId}) 已通過第 ${currentStep} 關，目前轉交下一關主管審核中。`);
                        }
                        await replyLineMessage(event.replyToken, `單號 #${formId} 已核准，並轉交下一關主管。`);
                    }
                }
            } catch (err) {
                console.error(err);
                await replyLineMessage(event.replyToken, '系統錯誤，無法完成簽核作業。');
            }
        }
    }
});

// 封裝回覆訊息至 LINE API
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

// 封裝主動推播訊息至 LINE API
async function sendLineMessage(lineUserId, messageContent) {
    if (!lineUserId || !LINE_TOKEN) return;
    const messagesObj = Array.isArray(messageContent) ? messageContent :
        (typeof messageContent === 'string' ? [{ type: 'text', text: messageContent }] : [messageContent]);
    try {
        await axios.post('https://api.line.me/v2/bot/message/push', {
            to: lineUserId,
            messages: messagesObj
        }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` } });
    } catch (err) { console.error('推播失敗', err.response ? JSON.stringify(err.response.data) : err.message); }
}

module.exports = { router, sendLineMessage };