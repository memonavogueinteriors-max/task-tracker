/**
 * TEAM TASK TRACKER — GOOGLE SHEETS + EMAIL CONNECTOR
 *
 * SETUP
 * 1. Open the Google Sheet → Extensions → Apps Script.
 * 2. Replace Code.gs with this entire file.
 * 3. Project Settings → Script Properties → add:
 *      APPS_SCRIPT_SHARED_SECRET = the same private value used in Vercel.
 * 4. Deploy → Manage deployments → Edit/New version → Web app.
 * 5. Execute as: Me. Who has access: Anyone.
 * 6. Copy the /exec URL into Owner Settings in the Task Tracker.
 */

const SHEET_NAME = 'Morning Huddle 1-3-5';
const SECRET_PROPERTY = 'APPS_SCRIPT_SHARED_SECRET';
const HEADERS = [
  'Task ID', 'Date', 'Employee ID', 'Employee Name', 'Department', 'Priority',
  'Task', 'Duration', 'Hours Decimal', 'Status', 'Notes', 'Assigned By',
  'Login Time', 'Logout Time', 'Finished Day', 'Updated At'
];

function doGet() {
  return json_({
    ok: true,
    message: 'Task Tracker Google Sheets and email connector is running.'
  });
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    authorize_(payload);

    if (payload.action === 'test') {
      return json_({ ok: true, message: 'Connection successful.' });
    }

    if (payload.action === 'upsertTask') {
      upsertTask_(getSheet_(), payload.row || {});
      return json_({ ok: true });
    }

    if (payload.action === 'deleteTask') {
      deleteTask_(getSheet_(), String(payload.taskId || ''));
      return json_({ ok: true });
    }

    if (payload.action === 'sendTaskEmail') {
      sendTaskEmail_(payload.email || {});
      return json_({ ok: true, remainingDailyQuota: MailApp.getRemainingDailyQuota() });
    }

    return json_({ ok: false, error: 'Unknown action.' });
  } catch (error) {
    return json_({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

function authorize_(payload) {
  const configuredSecret = String(
    PropertiesService.getScriptProperties().getProperty(SECRET_PROPERTY) || ''
  ).trim();

  if (configuredSecret) {
    if (String(payload.connectorSecret || '') !== configuredSecret) {
      throw new Error('Connector authorization failed. Check the shared secret.');
    }
    return;
  }

  if (payload.action === 'sendTaskEmail') {
    throw new Error(
      'Email is disabled until APPS_SCRIPT_SHARED_SECRET is added in Apps Script Project Settings.'
    );
  }
}

function getSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);

  ensureHeaders_(sheet);
  return sheet;
}

function ensureHeaders_(sheet) {
  if (sheet.getMaxColumns() < HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());
  }

  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  const header = sheet.getRange(1, 1, 1, HEADERS.length);
  header
    .setBackground('#0B1730')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  sheet.setFrozenRows(1);
  const widths = [220, 105, 115, 175, 150, 95, 310, 120, 95, 115, 250, 175, 105, 105, 105, 190];
  widths.forEach((width, index) => sheet.setColumnWidth(index + 1, width));
}

function upsertTask_(sheet, row) {
  const taskId = String(row.taskId || '').trim();
  if (!taskId) throw new Error('Task ID is required.');

  const values = [[
    taskId,
    row.date || '',
    row.employeeId || '',
    row.employeeName || '',
    row.department || '',
    row.priority || 'Medium',
    row.task || '',
    row.duration || '',
    Number(row.hours || 0),
    row.status || '',
    row.notes || '',
    row.assignedBy || '',
    row.loginTime || '',
    row.logoutTime || '',
    row.finishedDay ? 'Yes' : 'No',
    row.updatedAt || new Date().toISOString()
  ]];

  const rowNumber = findTaskRow_(sheet, taskId);
  if (rowNumber) {
    sheet.getRange(rowNumber, 1, 1, HEADERS.length).setValues(values);
    styleRow_(sheet, rowNumber);
  } else {
    const nextRow = sheet.getLastRow() + 1;
    sheet.getRange(nextRow, 1, 1, HEADERS.length).setValues(values);
    styleRow_(sheet, nextRow);
  }
}

function deleteTask_(sheet, taskId) {
  const rowNumber = findTaskRow_(sheet, taskId);
  if (rowNumber) sheet.deleteRow(rowNumber);
}

function findTaskRow_(sheet, taskId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const finder = sheet
    .getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(taskId)
    .matchEntireCell(true)
    .findNext();

  return finder ? finder.getRow() : 0;
}

function styleRow_(sheet, rowNumber) {
  const range = sheet.getRange(rowNumber, 1, 1, HEADERS.length);
  range.setBackground(rowNumber % 2 === 0 ? '#F7FAFC' : '#FFFFFF');
  range.setVerticalAlignment('middle');

  const priorityCell = sheet.getRange(rowNumber, 6);
  const priority = String(priorityCell.getValue());
  const priorityColors = {
    High: ['#FFF5F5', '#C53030'],
    Medium: ['#FFFAF0', '#C05621'],
    Low: ['#F0FFF4', '#276749']
  };
  const priorityColor = priorityColors[priority] || ['#FFFFFF', '#172033'];
  priorityCell
    .setBackground(priorityColor[0])
    .setFontColor(priorityColor[1])
    .setFontWeight('bold');

  const statusCell = sheet.getRange(rowNumber, 10);
  const status = String(statusCell.getValue());
  const statusColors = {
    Completed: ['#F0FFF4', '#276749'],
    'In Progress': ['#EBF8FF', '#2B6CB0'],
    Pending: ['#FFFAF0', '#C05621'],
    'On Hold': ['#F7FAFC', '#718096'],
    Review: ['#FAF5FF', '#6B46C1']
  };
  const statusColor = statusColors[status] || ['#FFFFFF', '#172033'];
  statusCell
    .setBackground(statusColor[0])
    .setFontColor(statusColor[1])
    .setFontWeight('bold');
}

function sendTaskEmail_(email) {
  const to = String(email.to || '').trim();
  const subject = String(email.subject || '').trim();
  const body = String(email.body || '').trim();
  const htmlBody = String(email.htmlBody || '').trim();
  const senderName = String(email.senderName || 'Team Task Tracker').trim();

  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new Error('A valid recipient email is required.');
  }
  if (!subject) throw new Error('Email subject is required.');
  if (!body) throw new Error('Email body is required.');
  if (MailApp.getRemainingDailyQuota() < 1) {
    throw new Error('Google Apps Script email quota has been reached for today.');
  }

  MailApp.sendEmail({
    to: to,
    subject: subject,
    body: body,
    htmlBody: htmlBody || undefined,
    name: senderName
  });
}

function json_(object) {
  return ContentService
    .createTextOutput(JSON.stringify(object))
    .setMimeType(ContentService.MimeType.JSON);
}
