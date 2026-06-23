const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

// 引入 LINE 推播模組與卡片通知功能
const { notifyNextApprovers, notifyApplicant } = require('./webhook'); 

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

// 輔助函式：產生核准 PDF 文件
async function generateApprovalPDF(applicationId, req) {
    return new Promise(async (resolve, reject) => {
        try {
            const pdfDir = path.join(__dirname, '../public/uploads/pdfs');
            if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });

            const [appRows] = await db.query(`
                SELECT a.id, a.content, a.created_at, f.name AS form_name, u.name AS applicant_name 
                FROM applications a
                JOIN form_types f ON a.form_type_id = f.id
                JOIN users u ON a.user_id = u.id
                WHERE a.id = ?
            `, [applicationId]);
            
            if (appRows.length === 0) return reject('表單不存在');
            const appData = appRows[0];
            const content = typeof appData.content === 'string' ? JSON.parse(appData.content) : appData.content;

            const [logRows] = await db.query(`
                SELECT l.step_number, u.name AS approver_name, l.action, l.comment, l.created_at
                FROM approval_logs l
                JOIN users u ON l.approver_id = u.id
                WHERE l.application_id = ?
                ORDER BY l.step_number ASC
            `, [applicationId]);

            const fileName = `approval_${applicationId}_${Date.now()}.pdf`;
            const filePath = path.join(pdfDir, fileName);
            
            const doc = new PDFDocument({ margin: 50 });
            const writeStream = fs.createWriteStream(filePath);
            doc.pipe(writeStream);

            // ⚠️ 確保 public/fonts 內有此中文字型檔，否則 PDF 無法顯示中文
            const fontPath = path.join(__dirname, '../public/fonts/NotoSansTC-Regular.ttf');
            if (fs.existsSync(fontPath)) {
                doc.font(fontPath);
            } else {
                console.warn("找不到中文字型檔，PDF 可能無法正確顯示中文。");
            }

            doc.fontSize(20).text('行政表單 - 核准證明文件', { align: 'center' });
            doc.moveDown(2);

            doc.fontSize(12);
            doc.text(`申請單號：#${appData.id}`);
            doc.text(`申請人員：${appData.applicant_name}`);
            doc.text(`表單類型：${appData.form_name}`);
            doc.text(`建檔時間：${new Date(appData.created_at).toLocaleString('zh-TW')}`);
            doc.moveDown(2);

            doc.fontSize(16).text('【表單明細】');
            doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
            doc.moveDown(0.5);

            doc.fontSize(12);
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

            for (let key in content) {
                if (key === 'formType' || key === 'userId' || key === 'data_compliance') continue;
                let dKey = tDict[key] || key;
                let dVal = tVal[content[key]] || content[key];
                if (typeof dVal === 'string' && dVal.startsWith('/uploads/')) dVal = '(已提供電子附件)';
                doc.text(`${dKey}：${dVal}`);
                doc.moveDown(0.3);
            }
            doc.moveDown(1.5);

            doc.fontSize(16).text('【簽核歷程紀錄】');
            doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
            doc.moveDown(0.5);

            doc.fontSize(12);
            logRows.forEach(log => {
                const actionText = log.action === 'APPROVE' ? '核准' : '駁回';
                const timeStr = new Date(log.created_at).toLocaleString('zh-TW');
                const stepRoleMap = { 1: '單位主管', 2: '管理部主任', 3: '資安長', 4: '班主任' };
                const roleName = stepRoleMap[log.step_number] || '主管';
                
                doc.text(`[${roleName}] ${log.approver_name} - 狀態：${actionText}`);
                doc.text(`時間：${timeStr}`);
                doc.text(`意見：${log.comment || '無'}`);
                doc.moveDown(0.8);
            });

            doc.end();

            writeStream.on('finish', () => {
                const protocol = req.headers['x-forwarded-proto'] || req.protocol;
                const host = req.get('host');
                const fileUrl = `${protocol}://${host}/uploads/pdfs/${fileName}`;
                resolve(fileUrl);
            });
            writeStream.on('error', (err) => reject(err));
        } catch (err) {
            reject(err);
        }
    });
}

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
            SELECT a.id AS application_id, u.name AS applicant_name, f.name AS form_type_name, f.id AS form_type_id, a.created_at, a.current_step, a.content
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
            await notifyApplicant(applicantLineId, applicationId, formName, 'REJECTED', null, comment);
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
            
            // 產生 PDF 並取得下載網址
            let pdfUrl = null;
            try {
                pdfUrl = await generateApprovalPDF(applicationId, req);
            } catch (pdfErr) {
                console.error("PDF 產生失敗：", pdfErr);
            }

            await notifyApplicant(applicantLineId, applicationId, formName, 'APPROVED_FINAL', null, null, pdfUrl);
            res.json({ success: true, message: '最終簽核完成，表單已正式結案。' });
        } else {
            await db.query('UPDATE applications SET current_step = ? WHERE id = ?', [nextStep, applicationId]);
            await notifyApplicant(applicantLineId, applicationId, formName, 'FORWARDED', nextStep, null);
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

    if (!allowedRoles.includes(role)) return res.status(403).json({ success: false, error: '權限不足' });

    try {
        const [rows] = await db.query(`
            SELECT a.id AS application_id, u.name AS applicant_name, f.name AS form_type_name, f.id AS form_type_id,
                   a.created_at, a.status, a.current_step, a.content
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