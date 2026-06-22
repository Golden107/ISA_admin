const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// 💡 1. 確保上傳資料夾存在 (儲存在 public/uploads)
const uploadDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 💡 2. 設定 Multer 儲存引擎，自動重新命名避免亂碼與覆蓋
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

// 💡 3. API: 員工送出新申請單 (升級：加入 upload.any() 接收實體檔案)
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
        res.json({ success: true, message: '表單已成功送出並寫入資料庫！' });
    } catch (error) {
        console.error('資料庫寫入失敗：', error);
        res.status(500).json({ success: false, error: '系統錯誤，無法儲存表單' });
    }
});

// 💡 4. API: 取得待簽核清單 (升級：SELECT 加入 a.content 供燈箱讀取)
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
            SELECT a.id AS application_id, f.name AS form_type_name, a.created_at, a.status, a.current_step, f.id AS form_type_id
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

module.exports = router;