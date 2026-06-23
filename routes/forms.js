const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// 引入 LINE 推播模組
const { sendLineMessage, notifyNextApprovers } = require('./webhook'); 

const uploadDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadDir); },
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

router.post('/apply', upload.any(), async (req, res) => {
    const { userId, formType, ...contentData } = req.body;
    const formTypeId = formTypeMapping[formType] || 1;

    if (req.files && req.files.length > 0) {
        req.files.forEach(file => { contentData[file.fieldname] = `/uploads/${file.filename}`; });
    }

    try {
        const [result] = await db.query(
            'INSERT INTO applications (user_id, form_type_id, content, status, current_step) VALUES (?, ?, ?, ?, ?)',
            [userId, formTypeId, JSON.stringify(contentData), 'PENDING', 1]
        );
        
        const newFormId = result.insertId; 
        
        // 呼叫模組，自動發送精美卡片給第一關的主管
        await notifyNextApprovers(newFormId);

        res.json({ success: true, message: '表單已成功送出並進入簽核流程。' });
    } catch (error) {
        console.error('資料庫寫入失敗：', error);
        res.status(500).json({ success: false, error: '系統錯誤，無法儲存表單' });
    }
});

router.get('/pending/:role', async (req, res) => {
    const role = req.params.role;
    if (role === 'EMPLOYEE') return res.json({ success: true, data: [] });

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

router.post('/:id/review', async (req, res) => {
    const applicationId = req.params.id;
    const { action, comment, approverId } = req.body;

    try {
        const [apps] = await db.query(`
            SELECT a.current_step, a.form_type_id, u.line_user_id AS applicant_line_id, f.name AS form_name
            FROM applications a
            JOIN users u ON a.user_id = u.id
            JOIN form_types f ON a.form_type_id = f.id
            WHERE a.id = ?
        `, [applicationId]);

        if (apps.length === 0) return res.status(404).json({ success: false, error: '找不到該表單' });

        const { current_step: currentStep, form_type_id: formTypeId, applicant_line_id: applicantLineId, form_name: formName } = apps[0];

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
            // 呼叫模組，自動發送卡片推播給下一關主管！
            await notifyNextApprovers(applicationId);

            res.json({ success: true, message: '已核准，表單已自動轉交下一關。' });
        }

    } catch (error) {
        console.error('簽核更新失敗：', error);
        res.status(500).json({ success: false, error: '簽核作業處理失敗' });
    }
});

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
        res.status(500).json({ success: false, error: '無法讀取資料' });
    }
});

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
        res.status(500).json({ success: false, error: '無法讀取統計資料' });
    }
});

module.exports = router;