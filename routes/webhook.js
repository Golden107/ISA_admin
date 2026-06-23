const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const db = require('../db');
const router = express.Router();

const LINE_TOKEN = process.env.LINE_TOKEN;
const LINE_SECRET = process.env.LINE_SECRET;

const stepRoleMap = { 0: '職務代理人', 1: '單位主管', 2: '管理部主任', 3: '資安長', 4: '班主任' };

function buildFlexMessage(formId, formName, applicantName, applyDateStr, contentData) {
    const tDict = { 'payment_amount': '請款金額', 'payee_name': '受款人/廠商', 'payment_reason': '請款事由', 'receipt_file': '憑證檔案', 'leave_type': '假別', 'substitute': '代理人', 'leave_start': '開始時間', 'leave_end': '結束時間', 'leave_reason': '請假事由', 'proof_file': '證明文件', 'document_name': '文件名稱', 'seal_type': '印信種類', 'seal_copies': '用印份數', 'seal_reason': '用印事由', 'document_file': '文件電子檔', 'item_name': '申購物品', 'estimated_cost': '預估單價', 'quantity': '數量', 'procurement_reason': '申購原因', 'quote_file': '報價單', 'withdraw_amount': '提領金額', 'withdraw_date': '提領日期', 'withdraw_reason': '用途說明', 'copy_class': '班級名稱', 'copy_teacher': '授課老師', 'copy_content': '講義內容', 'copy_color': '影印類型', 'copy_pages': '總張數', 'data_target_type': '調閱對象', 'data_scope': '調閱範圍', 'data_purpose': '調閱目的' };
    const tVal = { 'annual': '特休', 'sick': '病假', 'personal': '事假', 'official': '公假', 'company': '補習班官印', 'representative': '班主任私章', 'both': '公司一般大小章', 'contract': '班主任職名章', 'sign': '班主任簽字章', 'black_white': '黑白', 'color': '彩色', 'student': '學生資料', 'parent': '家長資料', 'employee': '員工資料' };
    
    let detailContents = [];
    for (let key in contentData) {
        if (key === 'formType' || key === 'userId' || key === 'data_compliance' || key === 'substitute_id') continue;
        let dKey = tDict[key] || key;
        let dVal = tVal[contentData[key]] || contentData[key];
        if (typeof dVal === 'string' && dVal.startsWith('/uploads/')) dVal = '(已附電子檔，請至系統查看)';
        detailContents.push({ "type": "box", "layout": "horizontal", "margin": "sm", "contents": [ { "type": "text", "text": dKey, "size": "sm", "color": "#888888", "flex": 3 }, { "type": "text", "text": String(dVal), "size": "sm", "color": "#333333", "flex": 5, "wrap": true } ] });
    }
    if (detailContents.length === 0) detailContents.push({ "type": "text", "text": "無明細資料", "size": "sm", "color": "#888888" });

    return { type: "bubble", size: "mega", header: { "type": "box", "layout": "vertical", "backgroundColor": "#0F4C81", "contents": [ { "type": "text", "text": "待簽核任務", "color": "#ffffff", "weight": "bold", "size": "sm" }, { "type": "text", "text": `【${formName}】`, "color": "#ffffff", "weight": "bold", "size": "xl", "margin": "sm" } ] }, body: { "type": "box", "layout": "vertical", "contents": [ { "type": "box", "layout": "horizontal", "margin": "md", "contents": [ { "type": "text", "text": "申請人", "size": "sm", "color": "#888888", "flex": 3 }, { "type": "text", "text": applicantName, "size": "sm", "color": "#0F4C81", "weight": "bold", "flex": 5 } ] }, { "type": "box", "layout": "horizontal", "margin": "md", "contents": [ { "type": "text", "text": "申請日期", "size": "sm", "color": "#888888", "flex": 3 }, { "type": "text", "text": applyDateStr, "size": "sm", "color": "#333333", "flex": 5 } ] }, { "type": "separator", "margin": "lg", "color": "#E2E8F0" }, { "type": "box", "layout": "vertical", "margin": "lg", "contents": detailContents } ] }, footer: { "type": "box", "layout": "horizontal", "spacing": "sm", "contents": [ { "type": "button", "style": "primary", "color": "#38A169", "action": { "type": "postback", "label": "核准", "data": `action=APPROVE&formId=${formId}` } }, { "type": "button", "style": "primary", "color": "#E53E3E", "action": { "type": "postback", "label": "駁回", "data": `action=REJECT&formId=${formId}` } } ] } };
}

function buildPendingStatusMessage(formId, formName, currentStep) {
    const roleName = stepRoleMap[currentStep] || '未知主管';
    return { type: "bubble", size: "micro", header: { "type": "box", "layout": "vertical", "backgroundColor": "#D69E2E", "contents": [ { "type": "text", "text": "審核進行中", "color": "#ffffff", "weight": "bold", "size": "sm" } ] }, body: { "type": "box", "layout": "vertical", "paddingAll": "15px", "contents": [ { "type": "text", "text": formName, "weight": "bold", "size": "md", "wrap": true }, { "type": "text", "text": `單號：#${formId}`, "size": "xs", "color": "#888888", "margin": "sm" }, { "type": "separator", "margin": "md" }, { "type": "text", "text": "目前進度卡在：", "size": "xs", "color": "#888888", "margin": "md" }, { "type": "text", "text": roleName, "size": "sm", "color": "#E53E3E", "weight": "bold", "margin": "xs" } ] } };
}

async function notifyNextApprovers(applicationId) {
    try {
        const [apps] = await db.query(`SELECT a.id, u.name AS applicant_name, f.name AS form_name, a.created_at, a.content, a.current_step, a.status FROM applications a JOIN users u ON a.user_id = u.id JOIN form_types f ON a.form_type_id = f.id WHERE a.id = ?`, [applicationId]);
        if (apps.length === 0 || apps[0].status !== 'PENDING') return;
        const form = apps[0];
        const contentData = typeof form.content === 'string' ? JSON.parse(form.content) : form.content;
        const applyDateStr = new Date(form.created_at).toLocaleDateString('zh-TW');

        if (form.current_step === 0) {
            if (contentData.substitute_id) {
                const [subs] = await db.query('SELECT line_user_id FROM users WHERE id = ? AND line_user_id IS NOT NULL', [contentData.substitute_id]);
                if (subs.length > 0) {
                    const bubble = buildFlexMessage(form.id, form.form_name, form.applicant_name, applyDateStr, contentData);
                    await sendLineMessage(subs[0].line_user_id, { type: "flex", altText: "代理人簽核任務", contents: bubble });
                }
            }
            return;
        }

        let targetRoles = [];
        if (form.current_step === 1) targetRoles = ['MANAGER', '櫃檯主任'];
        else if (form.current_step === 2) targetRoles = ['DIRECTOR'];
        else if (form.current_step === 3) targetRoles = ['CISO'];
        else if (form.current_step === 4) targetRoles = ['PRINCIPAL'];

        if (targetRoles.length === 0) return;
        const [managers] = await db.query('SELECT line_user_id FROM users WHERE role IN (?) AND line_user_id IS NOT NULL', [targetRoles]);
        if (managers.length === 0) return;

        const bubble = buildFlexMessage(form.id, form.form_name, form.applicant_name, applyDateStr, contentData);
        const flexMsg = { type: "flex", altText: `新任務：【${form.form_name}】待簽核`, contents: bubble };
        for (let m of managers) { await sendLineMessage(m.line_user_id, flexMsg); }
    } catch (e) { console.error("發送下一關推播失敗：", e); }
}

async function notifyApplicant(lineUserId, formId, formName, status, nextStepNum, comment) {
    if (!lineUserId || !LINE_TOKEN) return;
    let title = "", color = "", desc = ""; let buttons = [];
    if (status === 'APPROVED_FINAL') {
        title = "表單結案通知"; color = "#38A169"; desc = `您的「${formName}」已完成最終決行，正式結案。`;
        buttons.push({ type: "button", style: "primary", color: "#0F4C81", margin: "md", action: { type: "uri", label: "下載核准證明 (PDF)", uri: `https://www.isaedu.com.tw/api/forms/${formId}/certificate` } });
    } else if (status === 'REJECTED') {
        title = "申請遭駁回"; color = "#E53E3E"; desc = `您的「${formName}」已遭到駁回。\n\n主管意見：${comment || '無'}`;
    } else if (status === 'FORWARDED') {
        title = "簽核進度更新"; color = "#D69E2E"; const nextRoleName = stepRoleMap[nextStepNum] || '主管';
        desc = `您的「${formName}」已通過審核！\n目前轉交【${nextRoleName}】簽核中。`;
    }
    const flexMsg = { type: "flex", altText: `單號 #${formId} 狀態更新`, contents: { type: "bubble", size: "kilo", body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "20px", contents: [ { type: "text", text: title, weight: "bold", color: color, size: "lg" }, { type: "text", text: `單號：#${formId}`, size: "sm", color: "#888888" }, { type: "separator", margin: "md", color: "#E2E8F0" }, { type: "text", text: desc, wrap: true, size: "md", color: "#333333", margin: "md" } ] }, footer: buttons.length > 0 ? { type: "box", layout: "vertical", contents: buttons } : undefined } };
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
                await replyLineMessage(event.replyToken, `請點擊下方專屬安全連結，前往網頁進行帳號綁定：\n\n🔗 ${baseUrl}/bind?lineId=${lineUserId}`);
            }
            else if (text === '待簽核項目' || text === '簽核中項目') {
                try {
                    const [users] = await db.query('SELECT id, role FROM users WHERE line_user_id = ?', [lineUserId]);
                    if (users.length === 0) return await replyLineMessage(event.replyToken, '系統查無綁定紀錄。請輸入「綁定」進行帳號連結。');

                    const user = users[0];
                    let targetSteps = [0];

                    if (user.role === 'CISO') {
                        targetSteps.push(1, 2, 3, 4);
                    } else {
                        if (user.role === 'MANAGER' || user.role === '櫃檯主任') targetSteps.push(1);
                        if (user.role === 'DIRECTOR') targetSteps.push(2);
                        if (user.role === 'PRINCIPAL') targetSteps.push(4);

                        const [delegators] = await db.query('SELECT role FROM users WHERE delegate_id = ?', [user.id]);
                        for (let d of delegators) {
                            if (d.role === 'MANAGER' || d.role === '櫃檯主任') targetSteps.push(1);
                            if (d.role === 'DIRECTOR') targetSteps.push(2);
                            if (d.role === 'CISO') targetSteps.push(3);
                            if (d.role === 'PRINCIPAL') targetSteps.push(4);
                        }
                    }

                    const [forms] = await db.query(`SELECT a.id, f.name AS form_name, u.name AS applicant_name, u.role AS applicant_role, a.created_at, a.current_step, a.content FROM applications a JOIN form_types f ON a.form_type_id = f.id JOIN users u ON a.user_id = u.id WHERE a.status = 'PENDING' AND a.current_step IN (?) ORDER BY a.created_at ASC`, [targetSteps]);

                    const filteredForms = forms.filter(f => {
                        if (f.current_step === 0) {
                            try {
                                const c = typeof f.content === 'string' ? JSON.parse(f.content) : f.content;
                                return String(c.substitute_id) === String(user.id);
                            } catch(e) { return false; }
                        }
                        return true;
                    }).slice(0, 10);

                    if (filteredForms.length === 0) {
                        await replyLineMessage(event.replyToken, '目前沒有需要您簽核的單據。');
                    } else {
                        const bubbles = filteredForms.map(f => {
                            const contentData = typeof f.content === 'string' ? JSON.parse(f.content) : f.content;
                            const applyDateStr = new Date(f.created_at).toLocaleDateString('zh-TW');
                            return buildFlexMessage(f.id, f.form_name, f.applicant_name, applyDateStr, contentData);
                        });
                        await replyLineMessage(event.replyToken, { type: "flex", altText: `待簽核清單 (${filteredForms.length}筆)`, contents: { type: "carousel", contents: bubbles } });
                    }
                } catch (err) { console.error(err); }
            }
        }
        else if (event.type === 'postback') {
            const params = new URLSearchParams(event.postback.data);
            const action = params.get('action');
            const formId = params.get('formId');

            try {
                const [users] = await db.query('SELECT id, role, name FROM users WHERE line_user_id = ?', [lineUserId]);
                if (users.length === 0) return await replyLineMessage(event.replyToken, '此帳號尚未綁定系統。');
                
                const [apps] = await db.query(`SELECT a.current_step, a.status, a.form_type_id, u.line_user_id AS applicant_line_id, u.role AS applicant_role, f.name AS form_name FROM applications a JOIN users u ON a.user_id = u.id JOIN form_types f ON a.form_type_id = f.id WHERE a.id = ?`, [formId]);

                if (apps.length === 0) return await replyLineMessage(event.replyToken, `單號 #${formId} 查無資料。`);
                const form = apps[0];
                if (form.status !== 'PENDING') return await replyLineMessage(event.replyToken, `單號 #${formId} 已處理完畢。`);

                await db.query('INSERT INTO approval_logs (application_id, approver_id, step_number, action, comment) VALUES (?, ?, ?, ?, ?)', [formId, users[0].id, form.current_step, action, "透過 LINE 快速審核"]);

                if (action === 'REJECT') {
                    await db.query('UPDATE applications SET status = "REJECTED" WHERE id = ?', [formId]);
                    await notifyApplicant(form.applicant_line_id, formId, form.form_name, 'REJECTED', null, "透過 LINE 快速審核");
                    await replyLineMessage(event.replyToken, `已駁回單號 #${formId}。`);
                } else if (action === 'APPROVE') {
                    let nextStep = form.current_step;
                    let isFinal = false;

                    if (form.current_step === 0) {
                        if (['EMPLOYEE', 'MANAGER', '櫃檯主任'].includes(form.applicant_role)) nextStep = 1;
                        else if (['DIRECTOR', 'CISO'].includes(form.applicant_role)) nextStep = 2;
                        else if (form.applicant_role === 'PRINCIPAL') nextStep = 4;
                    }
                    else if (form.current_step === 1) nextStep = 2;
                    else if (form.current_step === 2) {
                        if (form.form_type_id === 7) {
                            if (form.applicant_role === 'CISO') isFinal = true; // 資安長自請，主任同意即結案
                            else nextStep = 3;
                        }
                        else if (form.form_type_id === 3) {
                            if (form.applicant_role === 'CISO') nextStep = 4; // 資安長自請，跳過自己送班主任
                            else nextStep = 3;
                        }
                        else nextStep = 4; // 其他表單跳過資安長直達班主任
                    }
                    else if (form.current_step === 3) {
                        if (form.form_type_id === 7) isFinal = true;
                        else if (form.form_type_id === 3) nextStep = 4;
                    }
                    else if (form.current_step === 4) {
                        isFinal = true;
                    }

                    if (isFinal) {
                        await db.query('UPDATE applications SET status = "APPROVED" WHERE id = ?', [formId]);
                        await notifyApplicant(form.applicant_line_id, formId, form.form_name, 'APPROVED_FINAL', null, null);
                        await replyLineMessage(event.replyToken, `單號 #${formId} 已完成決行。`);
                    } else {
                        await db.query('UPDATE applications SET current_step = ? WHERE id = ?', [nextStep, formId]);
                        await notifyApplicant(form.applicant_line_id, formId, form.form_name, 'FORWARDED', nextStep, null);
                        await notifyNextApprovers(formId);
                        await replyLineMessage(event.replyToken, `單號 #${formId} 已核准轉交。`);
                    }
                }
            } catch (err) { console.error(err); }
        }
    }
});

async function replyLineMessage(replyToken, messageContent) {
    if (!LINE_TOKEN) return;
    const messagesObj = Array.isArray(messageContent) ? messageContent : (typeof messageContent === 'string' ? [{ type: 'text', text: messageContent }] : [messageContent]);
    try { await axios.post('https://api.line.me/v2/bot/message/reply', { replyToken: replyToken, messages: messagesObj }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` } }); } catch (err) {}
}

async function sendLineMessage(lineUserId, messageContent) {
    if (!lineUserId || !LINE_TOKEN) return;
    const messagesObj = Array.isArray(messageContent) ? messageContent : (typeof messageContent === 'string' ? [{ type: 'text', text: messageContent }] : [messageContent]);
    try { await axios.post('https://api.line.me/v2/bot/message/push', { to: lineUserId, messages: messagesObj }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` } }); } catch (err) {}
}

module.exports = { router, sendLineMessage, notifyNextApprovers, notifyApplicant };
