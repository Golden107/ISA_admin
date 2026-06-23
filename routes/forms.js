const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// 引入 LINE 推播模組
const { sendLineMessage } = require('./webhook');

// 確保檔案上傳目錄存在
const uploadDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 設定 Multer 儲存機制
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// 表單類型對應表
const formTypeMapping = {
    'payment': 1, 'leave': 2, 'seal': 3, 'procurement': 4,
    'cash_withdraw': 5, 'copy_record': 6, 'data_access': 7
};

// API: 員工送出新申請單
router.post('/apply', upload.any(), async (req, res) => {
    const { userId, formType, ...contentData } = req.body;
    const formTypeId = formTypeMapping[formType] || 1;

    // 處理上傳的附件路徑
    if (req.files && req.files.length > 0) {
        req.files.forEach(file => {
            contentData[file.fieldname] = `/uploads/${file.filename}`;
        });
    }

    try {
        // 將申請單資料寫入資料庫
        const [result] = await db.query(
            'INSERT INTO applications (user_id, form_type_id, content, status, current_step) VALUES (?, ?, ?, ?, ?)',
            [userId, formTypeId, JSON.stringify(contentData), 'PENDING', 1]
        );

        const newFormId = result.insertId;

        // 發送 LINE 通知給第一關主管
        try {
            const [managers] = await db.query('SELECT line_user_id FROM users WHERE role IN ("MANAGER", "櫃檯主任") AND line_user_id IS NOT NULL');

            if (managers.length > 0) {
                // 取得申請人姓名
                const [uRows] = await db.query('SELECT name FROM users WHERE id = ?', [userId]);
                const applicantName = uRows.length > 0 ? uRows[0].name : '未知員工';
                const applyDate = new Date().toLocaleDateString('zh-TW');

                // 完整對應 apply.html 最新異動之表單欄位翻譯字典
                const tDict = {
                    'payment_amount': '請款金額', 'payee_name': '受款人/廠商', 'payment_reason': '請款事由', 'receipt_file': '憑證檔案',
                    'leave_type': '假別', 'substitute': '代理人', 'leave_start': '開始時間', 'leave_end': '結束時間', 'leave_reason': '請假事由', 'proof_file': '證明文件',
                    'document_name': '文件名稱', 'seal_type': '印信種類', 'seal_copies': '用印份數', 'seal_reason': '用印事由', 'document_file': '文件電子檔',
                    'item_name': '申購物品', 'estimated_cost': '預估單價', 'quantity': '數量', 'procurement_reason': '申購原因', 'quote_file': '報價單',
                    'withdraw_amount': '提領金額', 'withdraw_date': '提領日期', 'withdraw_reason': '用途說明',
                    'copy_class': '班級名稱', 'teacher': '授課老師', 'text': '講義內容', 'copy_color': '影印類型', 'copy_pages': '總張數',
                    'data_target_type': '調閱對象', 'data_scope': '調閱範圍', 'data_purpose': '調閱目的'
                };

                // 完整對應 apply.html 最新調整之選單選項值翻譯字典
                const tVal = {
                    'annual': '特休', 'sick': '病假', 'personal': '事假', 'official': '公假',
                    'company': '補習班官印', 'representative': '班主任私章', 'both': '公司一般大小章', 'contract': '班主任職名章', 'sign': '班主任簽字章',
                    'black_white': '黑白', 'color': '彩色',
                    'student': '學生資料', 'parent': '家長資料', 'employee': '員工資料'
                };

                const formTypes = { 1: '請款申請單', 2: '請假申請單', 3: '用印申請單', 4: '採購申請單', 5: '現金提領申請', 6: '影印登記表', 7: '個資調閱申請' };

                // 處理表單明細內容與排版
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

                // 組裝 LINE Flex Message
                const flexMessage = {
                    type: "flex",
                    altText: `新申請單待簽核：單號 #${newFormId}`,
                    contents: {
                        "type": "bubble",
                        "size": "mega",
                        "header": {
                            "type": "box", "layout": "vertical", "backgroundColor": "#0F4C81",
                            "contents": [
                                { "type": "text", "text": "待簽核任務", "color": "#ffffff", "weight": "bold", "size": "sm" },
                                { "type": "text", "text": `【${formTypes[formTypeId]}】`, "color": "#ffffff", "weight": "bold", "size": "xl", "margin": "sm" }
                            ]
                        },
                        "body": {
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
                                        { "type": "text", "text": applyDate, "size": "sm", "color": "#333333", "flex": 5 }
                                    ]
                                },
                                {
                                    "type": "separator", "margin": "lg", "color": "#E2E8F0"
                                },
                                {
                                    "type": "box", "layout": "vertical", "margin": "lg",
                                    "contents": detailContents
                                }
                            ]
                        },
                        "footer": {
                            "type": "box", "layout": "horizontal", "spacing": "sm",
                            "contents": [
                                { "type": "button", "style": "primary", "color": "#38A169", "action": { "type": "postback", "label": "核准", "data": `action=APPROVE&formId=${newFormId}` } },
                                { "type": "button", "style": "primary", "color": "#E53E3E", "action": { "type": "postback", "label": "駁回", "data": `action=REJECT&formId=${newFormId}` } }
                            ]
                        }
                    }
                };

                // 推播給所有符合權限的主管
                for (let manager of managers) {
                    await sendLineMessage(manager.line_user_id, flexMessage);
                }
            }
        } catch (lineErr) {
            console.error('發送 LINE 通知失敗', lineErr);
        }

        res.json({ success: true, message: '表單已成功送出並進入簽核流程。' });
    } catch (error) {
        console.error('資料庫寫入失敗：', error);
        res.status(500).json({ success: false, error: '系統錯誤，無法儲存表單' });
    }
});

// API: 取得待簽核清單
router.get('/pending/:role', async (req, res) => {
    const role = req.params.role;

    if (role === 'EMPLOYEE') return res.json({ success: true, data: [] });

    // 判斷角色對應的簽核關卡
    let targetStep = 0;
    if (role === 'MANAGER' || role === '櫃檯主任') targetStep = 1;
    if (role === 'DIRECTOR') targetStep = 2;
    if (role === 'CISO') targetStep = 3;
    if (role === 'PRINCIPAL') targetStep = 4;

    try {
        const [rows] = await db.query(`
            SELECT a.id AS application_id, u.name AS applicant_name, f.name AS form_type_name, a.created_at, a.current_step, a.content
            FROM applications a
            JOIN users u ON a.user_id = u.id
            JOIN form_types f ON a.form_type_id = f.id
            WHERE a.status = 'PENDING' AND a.current_step = ?
            ORDER BY a.created_at DESC
        `, [targetStep]);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, error: '無法讀取資料' });
    }
});

// API: 取得登入者自己的申請紀錄
router.get('/my-records/:userId', async (req, res) => {
    const userId = req.params.userId;
    try {
        const [rows] = await db.query(`
            SELECT a.id AS application_id, f.name AS form_type_name, a.created_at, a.status, a.current_step, f.id AS form_type_id, a.content
            FROM applications a
            JOIN form_types f ON a.form_type_id = f.id
            WHERE a.user_id = ?
            ORDER BY a.created_at DESC
        `, [userId]);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, error: '無法讀取資料' });
    }
});

// API: 主管進行簽核動作 (包含動態工作流與申請者通知)
router.post('/:id/review', async (req, res) => {
    const applicationId = req.params.id;
    const { action, comment, approverId } = req.body;

    try {
        // 取得當前表單狀態、類型與申請者的 LINE ID
        const [apps] = await db.query(`
            SELECT a.current_step, a.form_type_id, u.line_user_id AS applicant_line_id, f.name AS form_name
            FROM applications a
            JOIN users u ON a.user_id = u.id
            JOIN form_types f ON a.form_type_id = f.id
            WHERE a.id = ?
        `, [applicationId]);

        if (apps.length === 0) return res.status(404).json({ success: false, error: '找不到該表單' });

        const { current_step: currentStep, form_type_id: formTypeId, applicant_line_id: applicantLineId, form_name: formName } = apps[0];

        // 紀錄簽核歷程
        await db.query(
            'INSERT INTO approval_logs (application_id, approver_id, step_number, action, comment) VALUES (?, ?, ?, ?, ?)',
            [applicationId, approverId, currentStep, action, comment]
        );

        if (action === 'REJECT') {
            await db.query('UPDATE applications SET status = "REJECTED" WHERE id = ?', [applicationId]);
            if (applicantLineId) {
                await sendLineMessage(applicantLineId, `【簽核通知】\n您的「${formName}」 (單號 #${applicationId}) 已遭到主管駁回。\n主管意見：${comment || '無'}`);
            }
            return res.json({ success: true, message: '已駁回表單，流程結束。' });
        }

        // 動態判斷下一關卡邏輯
        let nextStep = currentStep;
        let isFinal = false;

        if (formTypeId === 7) {
            // 規則 1：個資調閱 (1 -> 2 -> 3 最終決行)
            if (currentStep === 1) nextStep = 2;
            else if (currentStep === 2) nextStep = 3;
            else if (currentStep === 3) isFinal = true;
        } else if (formTypeId === 3) {
            // 規則 2：用印申請 (1 -> 2 -> 3 -> 4 最終決行)
            if (currentStep === 1) nextStep = 2;
            else if (currentStep === 2) nextStep = 3;
            else if (currentStep === 3) nextStep = 4;
            else if (currentStep === 4) isFinal = true;
        } else {
            // 規則 3：其他常規表單 (1 -> 2 -> 4 最終決行，跳過資安長)
            if (currentStep === 1) nextStep = 2;
            else if (currentStep === 2) nextStep = 4;
            else if (currentStep === 4) isFinal = true;
        }

        if (isFinal) {
            await db.query('UPDATE applications SET status = "APPROVED" WHERE id = ?', [applicationId]);
            if (applicantLineId) {
                await sendLineMessage(applicantLineId, `【簽核通知】\n恭喜！您的「${formName}」 (單號 #${applicationId}) 已完成最終決行並結案。`);
            }
            res.json({ success: true, message: '最終簽核完成，表單已正式結案。' });
        } else {
            await db.query('UPDATE applications SET current_step = ? WHERE id = ?', [nextStep, applicationId]);
            if (applicantLineId) {
                await sendLineMessage(applicantLineId, `【簽核通知】\n您的「${formName}」 (單號 #${applicationId}) 已通過第 ${currentStep} 關，目前轉交下一關主管審核中。`);
            }
            res.json({ success: true, message: '已核准，表單已自動轉交下一關。' });
        }

    } catch (error) {
        console.error('簽核更新失敗：', error);
        res.status(500).json({ success: false, error: '簽核作業處理失敗' });
    }
});

// API: 取得全系統申請紀錄 (僅限高階主管)
router.get('/all-records', async (req, res) => {
    const role = req.headers['x-user-role'];
    const allowedRoles = ['PRINCIPAL', 'DIRECTOR', 'CISO'];

    if (!allowedRoles.includes(role)) {
        return res.status(403).json({ success: false, error: '權限不足' });
    }

    try {
        const [rows] = await db.query(`
            SELECT a.id AS application_id, u.name AS applicant_name, f.name AS form_type_name, \n                   a.created_at, a.status, a.current_step, a.content
            FROM applications a
            JOIN users u ON a.user_id = u.id
            JOIN form_types f ON a.form_type_id = f.id
            ORDER BY a.created_at DESC
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('讀取總表失敗：', error);
        res.status(500).json({ success: false, error: '無法讀取資料' });
    }
});

// API: 大廳統計圖表資料
router.get('/stats', async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT f.name AS label, COUNT(a.id) AS value
            FROM applications a
            JOIN form_types f ON a.form_type_id = f.id
            GROUP BY f.id
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('統計讀取失敗：', error);
        res.status(500).json({ success: false, error: '無法讀取統計資料' });
    }
});

module.exports = router;