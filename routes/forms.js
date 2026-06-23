const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

const formTypeMapping = { 'payment': 1, 'leave': 2, 'seal': 3, 'procurement': 4, 'cash_withdraw': 5, 'copy_record': 6, 'data_access': 7 };

router.post('/apply', upload.any(), async (req, res) => {
    const { userId, formType, ...contentData } = req.body;
    const formTypeId = formTypeMapping[formType] || 1;

    // 解析代理人資料
    if (contentData.substitute_info) {
        contentData.substitute_id = contentData.substitute_info.split(':')[0];
        contentData.substitute = contentData.substitute_info.split(':')[1];
        delete contentData.substitute_info;
    }

    if (req.files && req.files.length > 0) {
        req.files.forEach(file => { contentData[file.fieldname] = `/uploads/${file.filename}`; });
    }

    try {
        const [users] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        const userRole = users[0].role;

        // 智慧化起始關卡
        let startStep = 1;
        if (formTypeId === 2) {
            startStep = 0; // 請假單強制進入 第 0 關 (職務代理人)
        } else {
            if (userRole === 'EMPLOYEE' || userRole === 'MANAGER' || userRole === '櫃檯主任') startStep = 1;
            else if (userRole === 'DIRECTOR' || userRole === 'CISO') startStep = 2; 
            else if (userRole === 'PRINCIPAL') startStep = 4;
        }

        const [result] = await db.query(
            'INSERT INTO applications (user_id, form_type_id, content, status, current_step) VALUES (?, ?, ?, ?, ?)',
            [userId, formTypeId, JSON.stringify(contentData), 'PENDING', startStep]
        );
        
        await notifyNextApprovers(result.insertId);
        res.json({ success: true, message: '表單已成功送出並進入簽核流程。' });
    } catch (error) {
        res.status(500).json({ success: false, error: '系統錯誤，無法儲存表單' });
    }
});

router.get('/pending/:role/:userId', async (req, res) => {
    const { role, userId } = req.params;
    if (role === 'EMPLOYEE') return res.json({ success: true, data: [] });

    let targetSteps = [0]; 

    if (role === 'CISO') {
        targetSteps.push(1, 2, 3, 4);
    } else {
        if (role === 'MANAGER' || role === '櫃檯主任') targetSteps.push(1);
        if (role === 'DIRECTOR') targetSteps.push(2);
        if (role === 'PRINCIPAL') targetSteps.push(4);

        const [delegators] = await db.query('SELECT role FROM users WHERE delegate_id = ?', [userId]);
        for (let d of delegators) {
            if (d.role === 'MANAGER' || d.role === '櫃檯主任') targetSteps.push(1);
            if (d.role === 'DIRECTOR') targetSteps.push(2);
            if (d.role === 'CISO') targetSteps.push(3);
            if (d.role === 'PRINCIPAL') targetSteps.push(4);
        }
    }

    try {
        const [rows] = await db.query(`
            SELECT a.id AS application_id, u.name AS applicant_name, u.role AS applicant_role, f.name AS form_type_name, f.id AS form_type_id, a.created_at, a.current_step, a.content
            FROM applications a
            JOIN users u ON a.user_id = u.id
            JOIN form_types f ON a.form_type_id = f.id
            WHERE a.status = 'PENDING' AND a.current_step IN (?)
            ORDER BY a.created_at DESC
        `, [targetSteps]);

        const filteredRows = rows.filter(row => {
            if (row.current_step === 0) {
                try {
                    const c = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
                    return String(c.substitute_id) === String(userId);
                } catch(e) { return false; }
            }
            return true;
        });

        res.json({ success: true, data: filteredRows });
    } catch (error) {
        res.status(500).json({ success: false, error: '無法讀取資料' });
    }
});

router.get('/my-records/:userId', async (req, res) => {
    const userId = req.params.userId;
    try {
        const [rows] = await db.query(`
            SELECT a.id AS application_id, u.role AS applicant_role, f.name AS form_type_name, a.created_at, a.status, a.current_step, f.id AS form_type_id, a.content
            FROM applications a
            JOIN form_types f ON a.form_type_id = f.id
            JOIN users u ON a.user_id = u.id
            WHERE a.user_id = ?
            ORDER BY a.created_at DESC
        `, [userId]);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, error: '無法讀取資料' });
    }
});

router.get('/:id/logs', async (req, res) => {
    try {
        const [logs] = await db.query(`
            SELECT l.step_number, l.action, u.name, u.role
            FROM approval_logs l
            JOIN users u ON l.approver_id = u.id
            WHERE l.application_id = ?
        `, [req.params.id]);
        res.json({ success: true, data: logs });
    } catch (error) {
        res.status(500).json({ success: false, error: '日誌讀取失敗' });
    }
});

router.post('/:id/review', async (req, res) => {
    const applicationId = req.params.id;
    const { action, comment, approverId } = req.body;

    try {
        const [apps] = await db.query(`
            SELECT a.current_step, a.form_type_id, u.line_user_id AS applicant_line_id, u.role AS applicant_role, f.name AS form_name
            FROM applications a
            JOIN users u ON a.user_id = u.id
            JOIN form_types f ON a.form_type_id = f.id
            WHERE a.id = ?
        `, [applicationId]);

        if (apps.length === 0) return res.status(404).json({ success: false, error: '找不到該表單' });

        const { current_step: currentStep, form_type_id: formTypeId, applicant_line_id: applicantLineId, applicant_role: applicantRole, form_name: formName } = apps[0];

        await db.query(
            'INSERT INTO approval_logs (application_id, approver_id, step_number, action, comment) VALUES (?, ?, ?, ?, ?)',
            [applicationId, approverId, currentStep, action, comment]
        );

        if (action === 'REJECT') {
            await db.query('UPDATE applications SET status = "REJECTED" WHERE id = ?', [applicationId]);
            await notifyApplicant(applicantLineId, applicationId, formName, 'REJECTED', null, comment);
            return res.json({ success: true, message: '已駁回表單，流程結束。' });
        }

        // 💡 智慧化下一關 (修正資安長特權邏輯)
        let nextStep = currentStep;
        let isFinal = false;

        if (currentStep === 0) { 
            if (['EMPLOYEE', 'MANAGER', '櫃檯主任'].includes(applicantRole)) nextStep = 1;
            else if (['DIRECTOR', 'CISO'].includes(applicantRole)) nextStep = 2;
            else if (applicantRole === 'PRINCIPAL') nextStep = 4;
        }
        else if (currentStep === 1) nextStep = 2;
        else if (currentStep === 2) {
            if (formTypeId === 7) {
                if (applicantRole === 'CISO') isFinal = true; // 資安長自請個資，主任同意即結案
                else nextStep = 3;
            }
            else if (formTypeId === 3) {
                if (applicantRole === 'CISO') nextStep = 4; // 資安長自請用印，跳過自己，送班主任
                else nextStep = 3;
            }
            else nextStep = 4; // 其餘表單一律跳過資安長，直達班主任
        }
        else if (currentStep === 3) {
            if (formTypeId === 7) isFinal = true; // 個資調閱停在資安長
            else if (formTypeId === 3) nextStep = 4; // 用印繼續往班主任送
        }
        else if (currentStep === 4) {
            isFinal = true; 
        }

        if (isFinal) {
            await db.query('UPDATE applications SET status = "APPROVED" WHERE id = ?', [applicationId]);
            await notifyApplicant(applicantLineId, applicationId, formName, 'APPROVED_FINAL', null, null);
            res.json({ success: true, message: '最終簽核完成，表單已正式結案。' });
        } else {
            await db.query('UPDATE applications SET current_step = ? WHERE id = ?', [nextStep, applicationId]);
            await notifyApplicant(applicantLineId, applicationId, formName, 'FORWARDED', nextStep, null);
            await notifyNextApprovers(applicationId);
            res.json({ success: true, message: '已核准，表單已自動轉交下一關。' });
        }

    } catch (error) {
        res.status(500).json({ success: false, error: '簽核作業處理失敗' });
    }
});

router.get('/all-records', async (req, res) => {
    const role = req.headers['x-user-role'];
    if (!['PRINCIPAL', 'DIRECTOR', 'CISO'].includes(role)) return res.status(403).json({ success: false, error: '權限不足' });
    try {
        const [rows] = await db.query(`SELECT a.id AS application_id, u.name AS applicant_name, u.role AS applicant_role, f.name AS form_type_name, f.id AS form_type_id, a.created_at, a.status, a.current_step, a.content FROM applications a JOIN users u ON a.user_id = u.id JOIN form_types f ON a.form_type_id = f.id ORDER BY a.created_at DESC`);
        res.json({ success: true, data: rows });
    } catch (error) { res.status(500).json({ success: false, error: '無法讀取資料' }); }
});

router.get('/stats', async (req, res) => {
    try {
        const [rows] = await db.query(`SELECT f.name AS label, COUNT(a.id) AS value FROM applications a JOIN form_types f ON a.form_type_id = f.id GROUP BY f.id`);
        res.json({ success: true, data: rows });
    } catch (error) { res.status(500).json({ success: false, error: '無法讀取統計資料' }); }
});

router.get('/:id/certificate', async (req, res) => {
    const formId = req.params.id;
    try {
        const [apps] = await db.query(`SELECT a.*, u.name AS applicant_name, f.name AS form_name FROM applications a JOIN users u ON a.user_id = u.id JOIN form_types f ON a.form_type_id = f.id WHERE a.id = ?`, [formId]);
        if (apps.length === 0 || apps[0].status !== 'APPROVED') return res.status(400).send('<h2 style="text-align:center; font-family:sans-serif; margin-top:50px;">此表單不存在或尚未完成所有簽核流程，無法產生憑證。</h2>');
        
        const form = apps[0];
        const [logs] = await db.query(`SELECT al.action, al.comment, al.created_at, u.name AS approver_name, u.role FROM approval_logs al JOIN users u ON al.approver_id = u.id WHERE al.application_id = ? ORDER BY al.created_at ASC`, [formId]);
        const roleMap = { 'MANAGER': '單位主管', '櫃檯主任': '櫃檯主任', 'DIRECTOR': '管理部主任', 'CISO': '資安長', 'PRINCIPAL': '班主任', 'EMPLOYEE': '一般員工' };
        
        let logsHtml = '';
        logs.forEach(log => {
            const dateStr = new Date(log.created_at).toLocaleString('zh-TW');
            const actionStr = log.action === 'APPROVE' ? '<span style="color:green;font-weight:bold;">核准通過</span>' : '<span style="color:red;font-weight:bold;">駁回</span>';
            const displayRole = log.role === 'EMPLOYEE' ? '職務代理人' : (roleMap[log.role] || log.role);
            logsHtml += `<tr><td style="padding:12px; border-bottom:1px solid #eee;">${dateStr}</td><td style="padding:12px; border-bottom:1px solid #eee;">${displayRole} - ${log.approver_name}</td><td style="padding:12px; border-bottom:1px solid #eee;">${actionStr}</td><td style="padding:12px; border-bottom:1px solid #eee; color:#666;">${log.comment || '-'}</td></tr>`;
        });

        const htmlContent = `
            <!DOCTYPE html>
            <html lang="zh-TW">
            <head>
                <meta charset="UTF-8">
                <title>核准證明書 - #${formId}</title>
                <style>
                    body { font-family: "Microsoft JhengHei", "PingFang TC", sans-serif; background: #f0f2f5; color: #333; padding: 20px; }
                    .page { background: #fff; max-width: 800px; margin: 0 auto; padding: 50px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); border-top: 10px solid #0F4C81; }
                    .header { text-align: center; border-bottom: 2px solid #0F4C81; padding-bottom: 20px; margin-bottom: 30px; position: relative; }
                    .header h1 { margin: 0; color: #0F4C81; font-size: 28px; letter-spacing: 2px; }
                    .header h2 { margin: 10px 0 0 0; color: #555; font-size: 20px; }
                    .header .stamp { position: absolute; top: 0; right: 0; color: #e53e3e; border: 3px solid #e53e3e; padding: 5px 15px; font-weight: bold; font-size: 18px; transform: rotate(-15deg); }
                    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 40px; background: #f8fafc; padding: 20px; border-radius: 8px; }
                    .info-item { font-size: 15px; }
                    .info-item span { font-weight: bold; color: #64748b; display: inline-block; width: 90px; }
                    h3 { color: #0F4C81; margin-bottom: 15px; font-size: 18px; border-left: 4px solid #0F4C81; padding-left: 10px; }
                    table { width: 100%; border-collapse: collapse; margin-bottom: 30px; font-size: 14px; }
                    th { background: #0F4C81; color: #fff; padding: 12px; text-align: left; }
                    .footer-note { text-align: center; font-size: 12px; color: #999; border-top: 1px dashed #ccc; padding-top: 20px; margin-top: 50px; }
                    .print-btn { display: block; width: 200px; margin: 30px auto; padding: 15px; background: #0F4C81; color: #fff; text-align: center; text-decoration: none; border-radius: 5px; font-weight: bold; cursor: pointer; border: none; }
                    @media (max-width: 768px) { .info-grid { grid-template-columns: 1fr; } .page { padding: 20px; } .header .stamp { position: static; display: inline-block; margin-top: 15px; } }
                    @media print { body { background: #fff; padding: 0; } .page { box-shadow: none; border-top: none; padding: 0; } .print-btn { display: none; } }
                </style>
            </head>
            <body>
                <button class="print-btn" onclick="window.print()">🖨️ 列印 / 儲存為 PDF</button>
                <div class="page">
                    <div class="header"><h1>行政簽核系統</h1><h2>${form.form_name} - 最終核准證明書</h2><div class="stamp">已結案 APPROVED</div></div>
                    <div class="info-grid"><div class="info-item"><span>表單單號：</span> #${form.id}</div><div class="info-item"><span>申請人員：</span> ${form.applicant_name}</div><div class="info-item"><span>申請日期：</span> ${new Date(form.created_at).toLocaleDateString('zh-TW')}</div><div class="info-item"><span>列印時間：</span> ${new Date().toLocaleString('zh-TW')}</div></div>
                    <h3>簽核歷程與時間戳記</h3>
                    <table><thead><tr><th width="25%">審核時間</th><th width="30%">審核層級 / 主管</th><th width="15%">決策</th><th width="30%">意見備註</th></tr></thead><tbody>${logsHtml}</tbody></table>
                    <div class="footer-note">此文件由行政簽核系統自動生成，具備完整電子簽核效力。</div>
                </div>
            </body>
            </html>
        `;
        res.send(htmlContent);
    } catch (error) { res.status(500).send("系統錯誤，無法產生憑證。"); }
});

module.exports = router;
