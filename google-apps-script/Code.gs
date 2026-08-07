/**
 * TEAM TASK TRACKER — GOOGLE SHEETS WEB APP
 * 1. Create/open a Google Sheet.
 * 2. Extensions → Apps Script.
 * 3. Replace Code.gs with this file.
 * 4. Deploy → New deployment → Web app.
 * 5. Execute as: Me. Who has access: Anyone.
 * 6. Copy the /exec URL into Owner Settings in the tracker.
 */

const SHEET_NAME = 'Task Tracker';
const HEADERS = [
  'Task ID', 'Date', 'Employee ID', 'Employee Name', 'Role', 'Task', 'Hours',
  'Status', 'Notes', 'Assigned By', 'Login Time', 'Logout Time',
  'Finished Day', 'Updated At'
];

function doGet() {
  return json_({ ok: true, message: 'Task Tracker Google Sheet connector is running.' });
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || '{}');
    const sheet = getSheet_();

    if (payload.action === 'upsertTask') {
      upsertTask_(sheet, payload.row || {});
      return json_({ ok: true });
    }

    if (payload.action === 'deleteTask') {
      deleteTask_(sheet, String(payload.taskId || ''));
      return json_({ ok: true });
    }

    if (payload.action === 'test') {
      return json_({ ok: true, message: 'Connection successful.' });
    }

    return json_({ ok: false, error: 'Unknown action.' });
  } catch (error) {
    return json_({ ok: false, error: String(error) });
  }
}

function getSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    const header = sheet.getRange(1, 1, 1, HEADERS.length);
    header.setBackground('#0B1730').setFontColor('#FFFFFF').setFontWeight('bold');
    sheet.setFrozenRows(1);
    const widths = [220,100,110,170,90,300,70,110,240,170,100,100,100,190];
    widths.forEach((width, index) => sheet.setColumnWidth(index + 1, width));
  }
  return sheet;
}

function upsertTask_(sheet, row) {
  const taskId = String(row.taskId || '');
  if (!taskId) throw new Error('Task ID is required.');

  const values = [[
    taskId,
    row.date || '',
    row.employeeId || '',
    row.employeeName || '',
    row.role || '',
    row.task || '',
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
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, HEADERS.length).setValues(values);
    styleRow_(sheet, sheet.getLastRow());
  }
}

function deleteTask_(sheet, taskId) {
  const rowNumber = findTaskRow_(sheet, taskId);
  if (rowNumber) sheet.deleteRow(rowNumber);
}

function findTaskRow_(sheet, taskId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const finder = sheet.getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(taskId)
    .matchEntireCell(true)
    .findNext();
  return finder ? finder.getRow() : 0;
}

function styleRow_(sheet, rowNumber) {
  const range = sheet.getRange(rowNumber, 1, 1, HEADERS.length);
  range.setBackground(rowNumber % 2 === 0 ? '#F7FAFC' : '#FFFFFF');
  const statusCell = sheet.getRange(rowNumber, 8);
  const status = String(statusCell.getValue());
  const colors = {
    'Completed': ['#F0FFF4', '#276749'],
    'In Progress': ['#EBF8FF', '#2B6CB0'],
    'Pending': ['#FFFAF0', '#C05621'],
    'On Hold': ['#F7FAFC', '#718096'],
    'Review': ['#FAF5FF', '#6B46C1']
  };
  const color = colors[status] || ['#FFFFFF', '#1A202C'];
  statusCell.setBackground(color[0]).setFontColor(color[1]).setFontWeight('bold');
}

function json_(object) {
  return ContentService
    .createTextOutput(JSON.stringify(object))
    .setMimeType(ContentService.MimeType.JSON);
}
