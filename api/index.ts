import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import ical from 'ical.js';

// --- Configuration and Secrets ---
// 這裡假設所有變數都已在 Vercel 環境中設定
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN!;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const DEFAULT_ICAL_URL = process.env.DEFAULT_ICAL_URL!;
const DEFAULT_CSV_URL = process.env.DEFAULT_CSV_URL!;
const TEACHER_EMAIL_EXCLUDE = process.env.TEACHER_EMAIL_EXCLUDE!.toLowerCase();

// 初始化 Supabase Client (使用 Service Role Key 繞過 RLS 進行寫入/讀取)
const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    {
        auth: {
            persistSession: false,
        },
    },
);

// --- 介面定義 (Interfaces) ---

interface TeacherConfig {
    line_user_id: string;
    ical_url: string;
    sheet_csv_url: string;
    teacher_email: string;
}

// --- 輔助函式 (Helper Functions) ---

// 1. 取得指定月份的開始和結束日期 (台灣時間 GMT+8)
function getMonthRangeGMT8(year: number, month: number): { start: Date; end: Date } {
    // 建立目標月份的第一天 (台灣時間)
    // Date.UTC 處理年、月、日，並校準 8 小時時差
    const start = new Date(Date.UTC(year, month - 1, 1, 0 - 8, 0, 0)); 
    
    // 建立目標月份的最後一天 (台灣時間)
    const end = new Date(Date.UTC(year, month, 1, 0 - 8, 0, 0)); 
    end.setSeconds(end.getSeconds() - 1); // 減一秒到上個月的最後一秒

    return { start, end };
}

// 2. 解析 iCal 檔案並計算時數
async function calculateHours(icalUrl: string, startDate: Date, endDate: Date, excludeEmail: string) {
    const icalResponse = await fetch(icalUrl);
    const icalText = await icalResponse.text();

    const jcalData = ical.parse(icalText);
    const vcalendar = new ical.Component(jcalData);
    const events = vcalendar.getAllSubcomponents('vevent');

    const studentHours = new Map<string, number>();
    const errorClasses: string[] = [];

    for (const vevent of events) {
        const event = new ical.Event(vevent);

        // 檢查日期範圍
        if (event.startDate.toJSDate() < startDate || event.endDate.toJSDate() > endDate) continue;

        // 計算時長 (小時)
        const durationMs = event.endDate.toJSDate().getTime() - event.startDate.toJSDate().getTime();
        const durationHours = durationMs / (1000 * 60 * 60);

        // 取得參與者郵件
        const attendees: string[] = vevent.getAllProperties('attendee')
            .map(prop => prop.getFirstValue().replace('mailto:', '').toLowerCase());

        // 找出學生郵件 (排除老師郵件)
        const studentEmails = attendees
            .filter(email => email !== excludeEmail.toLowerCase());

        // 檢查邊界條件：是否有多位學生 (需求 A.3)
        if (studentEmails.length !== 1) {
            // 格式化錯誤時間 (台灣時間)
            const eventStart = event.startDate.toJSDate();
            const timeString = `${eventStart.getFullYear()}/${eventStart.getMonth() + 1}/${eventStart.getDate()} ${eventStart.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' })}`;
            errorClasses.push(`[${timeString}]`);
            continue;
        }

        const studentEmail = studentEmails[0];
        
        // 累加時數
        studentHours.set(studentEmail, (studentHours.get(studentEmail) || 0) + durationHours);
    }
    
    return { studentHours, errorClasses };
}

// 3. 取得學生資料 (從 CSV)
async function getStudentData(csvUrl: string) {
    const response = await fetch(csvUrl);
    const csvText = await response.text();
    const lines = csvText.trim().split('\n');
    const studentMap = new Map<string, { name: string; fee: number }>();

    // 假設第一行是標頭 (姓名, 郵件, 費用)
    const dataLines = lines.slice(1);

    for (const line of dataLines) {
        // 使用正則表達式或更嚴謹的 CSV 解析來處理逗號在名稱中的情況，這裡簡化假設無逗號在名稱中
        const parts = line.split(',');
        const name = parts[0];
        const email = parts[1];
        const feeStr = parts[2];
        
        if (name && email && feeStr) {
            const fee = parseFloat(feeStr.trim());
            if (!isNaN(fee)) {
                studentMap.set(email.trim().toLowerCase(), { name: name.trim(), fee });
            }
        }
    }
    return studentMap;
}

// 4. LINE Messaging API Call (Push / Reply)
async function sendLineMessage(endpoint: 'reply' | 'push', target: string, messages: any[], token: string) {
    const url = `https://api.line.me/v2/bot/message/${endpoint}`;
    const payload = endpoint === 'reply' 
        ? { replyToken: target, messages } 
        : { to: target, messages };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`LINE API Error (${endpoint}): ${response.status} ${response.statusText}`);
        console.error(`Error Body: ${errorBody}`);
        throw new Error(`LINE API failed: ${errorBody}`);
    }
}

// 5. 格式化 LINE 訊息
function createLineMessages(
    studentHours: Map<string, number>, 
    studentData: Map<string, { name: string; fee: number }>,
    errorClasses: string[],
    month: number,
    year: number
) {
    const monthStr = `${year}年${month}月`;
    const notificationMessages: any[] = [];
    const unknownEmails: string[] = [];
    let hasBillingData = false;

    // 1. 處理繳費通知
    for (const [email, hours] of studentHours.entries()) {
        const student = studentData.get(email);
        if (!student) {
            unknownEmails.push(email);
            continue;
        }

        // 四捨五入到小數第二位 (時數與金額)
        const roundedHours = Math.round(hours * 100) / 100;
        const totalFee = Math.round((roundedHours * student.fee) * 100) / 100;

        const message = `${student.name}繳費通知\n上個月的上課總時數為${roundedHours}小時，費用是${totalFee}元\n再麻煩了~謝謝`;
        notificationMessages.push({ type: 'text', text: message });
        hasBillingData = true;
    }

    // 2. 處理行事曆錯誤通知 (多學生)
    if (errorClasses.length > 0) {
        const errorMsg = `🚨 ${monthStr}上課紀錄錯誤通知 🚨\n以下課程有兩位以上非教師參與者，無法正確計算費用：\n${errorClasses.join('\n')}\n\n處理方式：請老師重新確認會議時間後，重新送出計算費用指令。`;
        notificationMessages.push({ type: 'text', text: errorMsg });
    }

    // 3. 處理未知學生郵件通知
    if (unknownEmails.length > 0) {
        const unknownMsg = `⚠️ ${monthStr}資料庫錯誤通知 ⚠️\n以下郵件不存在學生資料表，請手動處理：\n${unknownEmails.join('\n')}`;
        notificationMessages.push({ type: 'text', text: unknownMsg });
    }

    if (!hasBillingData && notificationMessages.length === 0) {
        notificationMessages.push({ type: 'text', text: `✅ ${monthStr}計算完成，本月無上課紀錄。` });
    }

    return notificationMessages;
}


// --- 核心計算與通知邏輯 ---

async function runCalculationAndNotify(teacher: TeacherConfig, month: number, year: number, replyToken?: string) {
    const { start, end } = getMonthRangeGMT8(year, month);
    
    // 1. 計算時數與錯誤
    const { studentHours, errorClasses } = await calculateHours(teacher.ical_url, start, end, teacher.teacher_email);
    
    // 2. 取得學生資料
    const studentData = await getStudentData(teacher.sheet_csv_url);
    
    // 3. 格式化訊息
    const messages = createLineMessages(studentHours, studentData, errorClasses, month, year);

    // 4. 發送訊息
    if (replyToken) {
        // 手動觸發使用 Reply API
        await sendLineMessage('reply', replyToken, messages, LINE_ACCESS_TOKEN);
    } else {
        // 排程觸發使用 Push API
        await sendLineMessage('push', teacher.line_user_id, messages, LINE_ACCESS_TOKEN);
    }
}

// --- 主要事件處理 Handler ---

export default async (req: VercelRequest, res: VercelResponse) => {
    try {
        const requestBody = req.body;
        
        // --- A. Vercel Cron Job 排程觸發 ---
        if (req.headers['x-vercel-cron-enabled']) {
            const nowGMT8 = new Date(new Date().getTime() + 8 * 60 * 60 * 1000); // 台灣時間
            const targetDate = new Date(nowGMT8);
            targetDate.setMonth(targetDate.getMonth() - 1); // 上個月

            const year = targetDate.getFullYear();
            const month = targetDate.getMonth() + 1;
            
            // 讀取所有老師 (目前只有你一個)
            const { data: teachers, error } = await supabase.from('teachers').select('*');

            if (error || !teachers || teachers.length === 0) {
                 // 如果找不到老師，排程通知就會失敗 (這是設計上的預期)
                 console.error("No teachers registered or DB error:", error);
                 return res.status(500).json({ status: "Error", message: "No teachers registered for scheduled run." });
            }

            // 針對每個老師執行計算
            for (const teacher of teachers as TeacherConfig[]) {
                try {
                    // 自動計算上個月
                    await runCalculationAndNotify(teacher, month, year);
                } catch (e) {
                    console.error(`Scheduled calc failed for ${teacher.line_user_id}: ${e}`);
                    // 發送排程失敗通知給老師 (需求 A.5)
                    const failMsg = '本月自動排程計算費用失敗，請老師重新手動觸發流程。';
                    await sendLineMessage('push', teacher.line_user_id, [{ type: 'text', text: failMsg }], LINE_ACCESS_TOKEN);
                }
            }
            return res.status(200).json({ status: "Success", message: `Scheduled run for ${month}/${year} completed.` });
        }

        // --- B. LINE Webhook 觸發 ---
        if (!requestBody || !requestBody.events || requestBody.events.length === 0) {
            return res.status(400).send('No events in request');
        }
        
        const event = requestBody.events[0];
        const userId = event.source.userId;
        const replyToken = event.replyToken;

        // 檢查是否為訊息事件
        if (event.type === 'message' && event.message.type === 'text') {
            const text = event.message.text.trim();

            // 1. 註冊指令: 加入老師 (需求 A.1)
            if (text === '加入老師') {
                const confirmMessage = {
                    type: 'template',
                    altText: '請點擊「確認」按鈕完成老師註冊',
                    template: {
                        type: 'confirm',
                        text: '確認將您的 LINE ID 設定為本系統的老師嗎？ (這將啟用自動排程通知)',
                        actions: [
                            { type: 'postback', label: '確認', data: 'action=register&confirm=yes' },
                            { type: 'postback', label: '取消', data: 'action=register&confirm=no' },
                        ],
                    },
                };
                await sendLineMessage('reply', replyToken, [confirmMessage], LINE_ACCESS_TOKEN);
                return res.status(200).send('Registered prompt sent');
            }

            // 2. 手動計算指令: 計算<月份數字>月 (需求 A.2)
            const match = text.match(/計算(\d+)月/);
            if (match) {
                const month = parseInt(match[1]);
                const nowGMT8 = new Date(new Date().getTime() + 8 * 60 * 60 * 1000);
                const year = nowGMT8.getFullYear();

                // 檢查是否已註冊
                const { data: teacher } = await supabase.from('teachers').select('*').eq('line_user_id', userId).single();
                if (!teacher) {
                    await sendLineMessage('reply', replyToken, [{ type: 'text', text: '請先輸入「加入老師」完成註冊，才能使用計算功能。' }], LINE_ACCESS_TOKEN);
                    return res.status(200).send('Not registered');
                }

                // 執行計算
                await runCalculationAndNotify(teacher as TeacherConfig, month, year, replyToken);
                return res.status(200).send('Manual calculation triggered');
            }
        }
        
        // 3. Postback 處理 (註冊確認)
        if (event.type === 'postback' && event.postback.data.includes('action=register')) {
            const data = event.postback.data;
            if (data.includes('confirm=yes')) {
                // 執行註冊
                const { error } = await supabase.from('teachers').upsert({
                    line_user_id: userId,
                    ical_url: DEFAULT_ICAL_URL,
                    sheet_csv_url: DEFAULT_CSV_URL,
                    teacher_email: TEACHER_EMAIL_EXCLUDE,
                });

                if (error) {
                    console.error("DB Register Error:", error);
                    await sendLineMessage('reply', replyToken, [{ type: 'text', text: '註冊失敗，請檢查 Vercel logs。' }], LINE_ACCESS_TOKEN);
                    return res.status(500).send('DB error');
                }
                
                await sendLineMessage('reply', replyToken, [{ type: 'text', text: '恭喜！老師註冊完成。您已啟用自動排程和手動計算功能。' }], LINE_ACCESS_TOKEN);
            } else {
                await sendLineMessage('reply', replyToken, [{ type: 'text', text: '取消註冊。若需啟用，請再次輸入「加入老師」。' }], LINE_ACCESS_TOKEN);
            }
            return res.status(200).send('Postback handled');
        }

        // 預設回覆
        if (event.type === 'message' && event.message.type === 'text') {
            await sendLineMessage('reply', replyToken, [{ type: 'text', text: '請輸入「加入老師」進行註冊，或輸入「計算<月份數字>月」來手動計算費用。' }], LINE_ACCESS_TOKEN);
            return res.status(200).send('Default response sent');
        }
        
        return res.status(200).send('Event not handled');

    } catch (e) {
        console.error(`Handler Error: ${e.message}`);
        // 對於 LINE Webhook 呼叫，避免直接拋出錯誤，只回覆 500
        return res.status(500).send('Internal Server Error');
    }
};