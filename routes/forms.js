const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// 💡 1. 引入 LINE 推播模組
const { sendLineMessage } = require('./webhook');

// 確保上傳資料夾存在 (儲存在 public/uploads)
const uploadDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 設定 Multer 儲存引擎，自動重新命名避免亂碼與覆蓋
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

const formTypeMapping = {
    'payment': 1, 'leave': 2, 'seal': 3, 'procurement': 4,
    'cash_withdraw': 5, 'copy_record': 6, 'data_access': 7
};

// API: 員工送出新申請單
router.post('/apply', upload.any(), async (req, res) => {
    const { userId, formType, ...contentData } = req.body;
    const formTypeId = formTypeMapping[formType] || 1;

    // 若有上傳檔案，將檔案的儲存路徑寫入 JSON 內容中
    if (req.files && req.files.length > 0) {
        req.files.forEach(file => {
            contentData[file.fieldname] = `/uploads/${file.filename}`;
        });
    }

    try {
        const [result] = await db.query(
            'INSERT INTO applications (user_id, form_type_id, content, status, current_step) VALUES (?, ?, ?, ?, ?)',
            [userId, formTypeId, JSON.stringify(contentData), 'PENDING', 1]
        );

        // 💡 取得剛剛存入資料庫的新單號
        const newFormId = result.insertId;

        // --- 🚀 開始：發送包含「詳細明細」的 LINE 通知 ---
        try {
            const [managers] = await db.query('SELECT line_user_id FROM users WHERE role = "MANAGER" AND line_user_id IS NOT NULL');

            if (managers.length > 0) {
                // 1. 建立翻譯字典 (與前端大廳相同)
                const tDict = { 'payment_amount': '金額', 'payee_name': '受款人', 'payment_reason': '事由', 'leave_type': '假別', 'substitute': '代理人', 'leave_start': '開始', 'leave_end': '結束', 'leave_reason': '事由', 'document_name': '文件', 'seal_type': '印信', 'seal_copies': '份數', 'seal_reason': '事由', 'item_name': '物品', 'estimated_cost': '預估花費', 'quantity': '數量', 'procurement_reason': '原因', 'withdraw_amount': '金額', 'withdraw_date': '日期', 'withdraw_reason': '用途', 'copy_color': '類型', 'copy_pages': '張數', 'project_class': '專案/班級', 'data_target_type': '對象', 'data_scope': '範圍', 'data_purpose': '目的' };
                const tVal = { 'annual': '特休', 'sick': '病假', 'personal': '事假', 'official': '公假', 'company': '公司大章', 'representative': '負責小章', 'both': '大小章', 'contract': '合約章', 'black_white': '黑白', 'color': '彩色', 'student': '學生個資', 'parent': '家長個資', 'employee': '員工個資' };
                const formTypes = { 1: '請款申請', 2: '請假申請', 3: '用印申請', 4: '採購申請', 5: '現金提領', 6: '影印登記', 7: '個資調閱' };

                // 2. 組裝詳細內容文字
                let detailText = `📄 【${formTypes[formTypeId]}】 單號 #${newFormId}\n---\n`;
                for (let key in contentData) {
                    if (key === 'formType' || key === 'userId') continue;
                    let dKey = tDict[key] || key;
                    let dVal = tVal[contentData[key]] || contentData[key];
                    // 如果是檔案路徑，替換為提示文字
                    if (typeof dVal === 'string' && dVal.startsWith('/uploads/')) dVal = '(已上傳附件)';

                    detailText += `▪️ ${dKey}：${dVal}\n`;
                }

                // 3. 組合發送陣列：先送出一則「詳細內容純文字」，再送出一則「按鈕面板」
                const messagesArray = [
                    {
                        type: "text",
                        text: detailText.trim()
                    },
                    {
                        type: "template",
                        altText: `您有一筆新的表單待簽核：單號 #${newFormId}`,
                        template: {
                            type: "buttons",
                            text: `請問是否核准單號 #${newFormId}？\n(目前進度：單位主管)`,
                            actions: [
                                { type: "postback", label: "✅ 核准", data: `action=APPROVE&formId=${newFormId}` },
                                { type: "postback", label: "❌ 駁回", data: `action=REJECT&formId=${newFormId}` }
                            ]
                        }
                    }
                ];

                for (let manager of managers) {
                    await sendLineMessage(manager.line_user_id, messagesArray);
                }
            }
        } catch (lineErr) {
            console.error('發送 LINE 通知失敗', lineErr);
        }
        // --- 🚀 結束：發送 LINE 通知 ---
        res.json({ success: true, message: '表單已成功送出並進入簽核流程！' });
    } catch (error) {
        console.error('資料庫寫入失敗：', error);
        res.status(500).json({ success: false, error: '系統錯誤，無法儲存表單' });
    }
});

// API: 取得待簽核清單
router.get('/pending/:role', async (req, res) => {
    const role = req.params.role;

    if (role === 'EMPLOYEE') return res.json({ success: true, data: [] });

    let targetStep = 0;
    if (role === 'MANAGER') targetStep = 1;
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

// API: 主管進行簽核 (支援 4 階層嚴謹狀態機)
router.post('/:id/review', async (req, res) => {
    const applicationId = req.params.id;
    const { action, comment, approverId } = req.body;

    try {
        const [apps] = await db.query('SELECT current_step FROM applications WHERE id = ?', [applicationId]);
        if (apps.length === 0) return res.status(404).json({ success: false, error: '找不到該表單' });

        const currentStep = apps[0].current_step;

        await db.query(
            'INSERT INTO approval_logs (application_id, approver_id, step_number, action, comment) VALUES (?, ?, ?, ?, ?)',
            [applicationId, approverId, currentStep, action, comment]
        );

        if (action === 'REJECT') {
            await db.query('UPDATE applications SET status = "REJECTED" WHERE id = ?', [applicationId]);
            return res.json({ success: true, message: '已駁回表單，流程結束。' });
        }

        if (currentStep < 4) {
            await db.query('UPDATE applications SET current_step = current_step + 1 WHERE id = ?', [applicationId]);
            res.json({ success: true, message: '已核准！表單已自動轉交下一關主管。' });
        } else {
            await db.query('UPDATE applications SET status = "APPROVED" WHERE id = ?', [applicationId]);
            res.json({ success: true, message: '最終簽核完成，表單已正式結案！' });
        }

    } catch (error) {
        console.error('簽核更新失敗：', error);
        res.status(500).json({ success: false, error: '簽核失敗' });
    }
});

// API: 取得所有申請紀錄 (僅限高階主管)
router.get('/all-records', async (req, res) => {
    // 從 Header 讀取發送請求者的角色
    const role = req.headers['x-user-role'];
    const allowedRoles = ['PRINCIPAL', 'DIRECTOR', 'CISO'];

    if (!allowedRoles.includes(role)) {
        return res.status(403).json({ success: false, error: '權限不足' });
    }

    try {
        const [rows] = await db.query(`
            SELECT a.id AS application_id, u.name AS applicant_name, f.name AS form_type_name, 
                   a.created_at, a.status, a.current_step, a.content
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

module.exports = router;