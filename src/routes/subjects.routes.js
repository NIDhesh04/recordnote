import { SessionStorage } from '../services/storage.js';
import { sendJson, readJsonBody } from '../utils/http.js';

export async function handleSubjectRoutes(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/subjects') {
    const subjects = await SessionStorage.listSubjects();
    sendJson(res, 200, { subjects });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/subjects') {
    const body = await readJsonBody(req);
    if (!body.name || !String(body.name).trim()) {
      sendJson(res, 400, { error: 'Subject name is required.' });
      return true;
    }
    const subject = await SessionStorage.createSubject({
      name: body.name,
      code: body.code || '',
      description: body.description || ''
    });
    const subjects = await SessionStorage.listSubjects();
    sendJson(res, 201, { subject, subjects });
    return true;
  }

  return false;
}
