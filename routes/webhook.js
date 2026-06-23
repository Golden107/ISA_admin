const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const db = require('../db');
const router = express.Router();

const LINE_TOKEN = process.env.LINE_TOKEN;
const LINE_SECRET = process.env.LINE_SECRET;

const stepRoleMap = { 1: '單位主管', 2: '管理部主任', 3: '資安長', 4: '班主任' };

// 建立標準化 Mega Flex Message 卡片給主管審核用
function buildFlexMessage(formId, formName, applicantName, applyDateStr, contentData) {
    const tDict = {
        'payment_amount': '請款金額', 'payee_name': '受款人/廠商', 'payment_reason': '請款事由', 'receipt_file': '憑證檔案',
        'leave_type': '假別', 'substitute': '代理人', 'leave_start': '開始時間', 'leave_end': '結束時間', 'leave_reason': '請假事由', 'proof_file': '證明文件',
        'document_name': '文件名稱', 'seal_type': '印信種類', 'seal_copies': '用印份數', 'seal_reason': '用印事由', 'document_file': '文件電子檔',
        'item_name': '申購物品', 'estimated_cost': '預估單價', 'quantity': '數量', 'procurement_reason': '申購原因', 'quote_file': '報價單',
        'withdraw_amount': '提領金額', 'withdraw_date': '提領日期', 'withdraw_reason': '用途說明',
        'copy_class': '班級名稱', 'copy_teacher': '授課老師', 'copy_content': '講義內容', 'copy_color': '影印類型', 'copy_pages': '總張數',
        'data_target_type': '調閱對象', 'data_scope': '調閱範圍', 'data_purpose': '調閱目的'
    };

    const tVal = {
        'annual': '特休', 'sick': '病假', 'personal': '事假', 'official': '公假',
        'company': '補習班官印', 'representative': '班主任私章', 'both': '公司一般大小章', 'contract': '班主任職名章', 'sign': '班主任簽字章',
        'black_white': '黑白', 'color': '彩色',
        'student': '學生資料', 'parent': '家長資料', 'employee': '員工資料'
    };

    let detailContents = [];
    for (let key in contentData) {
        if (key === 'formType' || key === 'userId' || key === 'data_compliance') continue;
        let dKey = tDict[key] || key;
        let dVal = tVal[contentData[key]] || contentData[key];
        if (typeof dVal === 'string' && dVal.startsWith('/uploads/')) dVal = '(已附電子檔，請至系統查看)';

        detailContents.push({
            "type": "box", "layout": "horizontal", "margin": "sm",
            "contents": [
                { "type": "text", "text": dKey, "size": "sm", "color": "#888888", "flex": 3 },
                { "type": "text", "text": String(dVal), "size": "sm", "color": "#333333", "flex": 5, "wrap": true }
            ]
        });
    }

    if (detailContents.length === 0) {
        detailContents.push({ "type": "text", "text": "無明細資料", "size": "sm", "color": "#888888" });
    }

    return {
        type: "bubble",
        size: "mega",
        header: {
            "type": "box", "layout": "vertical", "backgroundColor": "#0F4C81",
            "contents": [
                { "type": "text", "text": "待簽核任務", "color": "#ffffff", "weight": "bold", "size": "sm" },
                { "type": "text", "text": `【${formName}】`, "color": "#ffffff", "weight": "bold", "size": "xl", "margin": "sm" }
            ]
        },
        body: {
            "type": "box", "layout": "vertical",
            "contents": [
                {
                    "type": "box", "layout": "horizontal", "margin": "md",
                    "contents": [
                        { "type": "text", "text": "申請人", "size": "sm", "color": "#888888", "flex": 3 },
                        { "type": "text", "text": applicantName, "size": "sm", "color": "#0F4C81", "weight": "bold", "flex": 5 }
                    ]
                },
                {
                    "type": "box", "layout": "horizontal", "margin": "md",
                    "contents": [
                        { "type": "text", "text": "申請日期", "size": "sm", "color": "#888888", "flex": 3 },
                        { "type": "text", "text": applyDateStr, "size": "sm", "color": "#333333", "flex": 5 }
                    ]
                },
                { "type": "separator", "margin": "lg", "color": "#E2E8F0" },
                { "type": "box", "layout": "vertical", "margin": "lg", "contents": detailContents }
            ]
        },
        footer: {
            "type": "box", "layout": "horizontal", "spacing": "sm",
            "contents": [
                { "type": "button", "style": "primary", "color": "#38A169", "action": { "type": "postback", "label": "核准", "data": `action=APPROVE&formId=${formId}` } },
                { "type": "button", "style": "primary", "color": "#E53E3E", "action": { "type": "postback", "label": "駁回", "data": `action=REJECT&formId=${formId}` } }
            ]
        }
    };
}

// 主動推播給下一關主管的功能
async function notifyNextApprovers(applicationId) {
    try {
        const [apps] = await db.query(`
            SELECT a.id, u.name AS applicant_name, f.name AS form_name, a.created_at, a.content, a.current_step, a.status 
            FROM applications a 
            JOIN users u ON a.user_id = u.id 
            JOIN form_types f ON a.form_type_id = f.id 
            WHERE a.id = ?
        `, [applicationId]);

        if (apps.length === 0 || apps[0].status !== 'PENDING') return;
        const form = apps[0];

        let targetRoles = [];
        if (form.current_step === 1) targetRoles = ['MANAGER', '櫃檯主任'];
        else if (form.current_step === 2) targetRoles = ['DIRECTOR'];
        else if (form.current_step === 3) targetRoles = ['CISO'];
        else if (form.current_step === 4) targetRoles = ['PRINCIPAL'];

        if (targetRoles.length === 0) return;

        const [managers] = await db.query('SELECT line_user_id FROM users WHERE role IN (?) AND line_user_id IS NOT NULL', [targetRoles]);
        if (managers.length === 0) return;

        const contentData = typeof form.content === 'string' ? JSON.parse(form.content) : form.content;
        const applyDateStr = new Date(form.created_at).toLocaleDateString('zh-TW');

        const bubble = buildFlexMessage(form.id, form.form_name, form.applicant_name, applyDateStr, contentData);
        const flexMsg = { type: "flex", altText: `新任務：【${form.form_name}】待簽核`, contents: bubble };

        for (let m of managers) {
            await sendLineMessage(m.line_user_id, flexMsg);
        }
    } catch (e) {
        console.error("發送下一關推播失敗：", e);
    }
}

// 專屬發送給「申請人」的精美卡片通知
async function notifyApplicant(lineUserId, formId, formName, status, nextStepNum, comment) {
    if (!lineUserId || !LINE_TOKEN) return;
    
    let title = "", color = "", desc = "";
    if (status === 'APPROVED_FINAL') {
        title = "✅ 表單結案通知"; color = "#38A169"; 
        desc = `您的「${formName}」已完成最終決行，正式結案。`;
    } else if (status === 'REJECTED') {
        title = "❌ 申請遭駁回"; color = "#E53E3E"; 
        desc = `您的「${formName}」已遭到主管駁回。\n\n主管意見：${comment || '無'}`;
    } else if (status === 'FORWARDED') {
        title = "⏳ 簽核進度更新"; color = "#D69E2E"; 
        const nextRoleName = stepRoleMap[nextStepNum] || '下一關主管';
        desc = `您的「${formName}」已通過審核！\n目前轉交【${nextRoleName}】簽核中。`;
    }

    const flexMsg = {
        type: "flex", altText: `【簽核通知】單號 #${formId} 狀態更新`,
        contents: {
            type: "bubble", size: "kilo",
            body: {
                type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
                contents: [
                    { type: "text", text: title, weight: "bold", color: color, size: "lg" },
                    { type: "text", text: `單號：#${formId}`, size: "sm", color: "#888888" },
                    { type: "separator", margin: "md", color: "#E2E8F0" },
                    { type: "text", text: desc, wrap: true, size: "md", color: "#333333", margin: "md" }
                ]
            }
        }
    };
    await sendLineMessage(lineUserId, flexMsg);
}

router.post('/line', async (req, res) => {
    if (!LINE_SECRET) return res.status(403).send('缺少 LINE_SECRET');

    const signature = crypto.createHmac('SHA256', LINE_SECRET).update(JSON.stringify(req.body)).digest('base64');
    if (req.headers['x-line-signature'] !== signature) return res.status(403).send('Unauthorized');

    res.sendStatus(200);

    const events = req.body.events;
    if (!events || events.length === 0) return;

    for (let event of events) {
        const lineUserId = event.source.userId;

        if (event.type === 'message' && event.message.type === 'text') {
            const text = event.message.text.trim();

            if (text.startsWith('綁定')) {
                const baseUrl = `https://${req.headers.host}`;
                const bindUrl = `${baseUrl}/bind?lineId=${lineUserId}`;
                await replyLineMessage(event.replyToken, `請點擊下方專屬安全連結，前往網頁進行帳號綁定：\n\n🔗 ${bindUrl}`);
            }
            // 💡 擴充關鍵字，避免圖文選單文字不一致導致沒反應
            else if (text === '待簽核項目' || text === '簽核中項目') {
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
                        SELECT a.id, f.name AS form_name, u.name AS applicant_name, a.created_at, a.content 
                        FROM applications a
                        JOIN form_types f ON a.form_type_id = f.id
                        JOIN users u ON a.user_id = u.id
                        WHERE a.status = 'PENDING' AND a.current_step = ?
                        ORDER BY a.created_at DESC LIMIT 10
                    `, [targetStep]);

                    if (forms.length === 0) {
                        await replyLineMessage(event.replyToken, '太棒了！您目前沒有任何待簽核的單據。');
                    } else {
                        const bubbles = forms.map(f => {
                            const contentData = typeof f.content === 'string' ? JSON.parse(f.content) : f.content;
                            const applyDateStr = new Date(f.created_at).toLocaleDateString('zh-TW');
                            return buildFlexMessage(f.id, f.form_name, f.applicant_name, applyDateStr, contentData);
                        });

                        const flexMsg = {
                            type: "flex", altText: `您有 ${forms.length} 筆待簽核單據`,
                            contents: { type: "carousel", contents: bubbles }
                        };
                        await replyLineMessage(event.replyToken, flexMsg);
                    }
                } catch (err) {
                    console.error(err);
                    await replyLineMessage(event.replyToken, '系統連線異常，無法讀取待簽核資料。');
                }
            }
        }
        else if (event.type === 'postback') {
            const data = event.postback.data;
            const params = new URLSearchParams(data);
            const action = params.get('action');
            const formId = params.get('formId');

            try {
                const [users] = await db.query('SELECT id, role, name FROM users WHERE line_user_id = ?', [lineUserId]);
                if (users.length === 0) {
                    await replyLineMessage(event.replyToken, '此帳號尚未綁定系統，無法執行簽核。');
                    return;
                }
                const approver = users[0];

                const [apps] = await db.query(`
                    SELECT a.current_step, a.status, a.user_id, a.form_type_id, u.line_user_id AS applicant_line_id, f.name AS form_name
                    FROM applications a
                    JOIN users u ON a.user_id = u.id
                    JOIN form_types f ON a.form_type_id = f.id
                    WHERE a.id = ?
                `, [formId]);

                if (apps.length === 0) {
                    await replyLineMessage(event.replyToken, `單號 #${formId} 查無此單據或已刪除。`);
                    return;
                }

                const form = apps[0];
                if (form.status !== 'PENDING') {
                    return await replyLineMessage(event.replyToken, `單號 #${formId} 已經處理完畢囉。`);
                }

                const comment = "透過 LINE 快速審核";
                await db.query(
                    'INSERT INTO approval_logs (application_id, approver_id, step_number, action, comment) VALUES (?, ?, ?, ?, ?)',
                    [formId, approver.id, form.current_step, action, comment]
                );

                if (action === 'REJECT') {
                    await db.query('UPDATE applications SET status = "REJECTED" WHERE id = ?', [formId]);
                    // 發送精美卡片給申請者
                    await notifyApplicant(form.applicant_line_id, formId, form.form_name, 'REJECTED', null, comment);
                    await replyLineMessage(event.replyToken, `已成功駁回單號 #${formId}。`);
                } else if (action === 'APPROVE') {
                    let nextStep = form.current_step;
                    let isFinal = false;

                    if (form.form_type_id === 7) {
                        if (form.current_step === 1) nextStep = 2;
                        else if (form.current_step === 2) nextStep = 3;
                        else if (form.current_step === 3) isFinal = true;
                    } else if (form.form_type_id === 3) {
                        if (form.current_step === 1) nextStep = 2;
                        else if (form.current_step === 2) nextStep = 3;
                        else if (form.current_step === 3) nextStep = 4;
                        else if (form.current_step === 4) isFinal = true;
                    } else {
                        if (form.current_step === 1) nextStep = 2;
                        else if (form.current_step === 2) nextStep = 4;
                        else if (form.current_step === 4) isFinal = true;
                    }

                    if (isFinal) {
                        await db.query('UPDATE applications SET status = "APPROVED" WHERE id = ?', [formId]);
                        await notifyApplicant(form.applicant_line_id, formId, form.form_name, 'APPROVED_FINAL', null, null);
                        await replyLineMessage(event.replyToken, `單號 #${formId} 已完成最終決行並結案。`);
                    } else {
                        await db.query('UPDATE applications SET current_step = ? WHERE id = ?', [nextStep, formId]);
                        await notifyApplicant(form.applicant_line_id, formId, form.form_name, 'FORWARDED', nextStep, null);
                        await replyLineMessage(event.replyToken, `單號 #${formId} 已核准，並轉交下一關主管。`);

                        // 通知下一關主管
                        await notifyNextApprovers(formId);
                    }
                }
            } catch (err) {
                console.error(err);
                await replyLineMessage(event.replyToken, '系統錯誤，無法完成簽核作業。');
            }
        }
    }
});

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
    } catch (err) { console.error('推播失敗', err.response ? JSON.stringify(err.response.data) : err.message); }
}

module.exports = { router, sendLineMessage, notifyNextApprovers, notifyApplicant };