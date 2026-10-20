const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'smilecraft_secure_jwt_secret_2026';

// Middleware to check authentication
const requireAuth = (req, res, next) => {
    const token = req.cookies.admin_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.adminId = decoded.adminId;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// API: Check status (used by frontend router)
router.get('/api/status', async (req, res) => {
    const adminCount = await req.db.collection('admins').countDocuments();
    const token = req.cookies.admin_token;
    let isAuthenticated = false;
    if (token) {
        try {
            jwt.verify(token, JWT_SECRET);
            isAuthenticated = true;
        } catch(e) {}
    }
    res.json({ needsSetup: adminCount === 0, isAuthenticated });
});

// API: Initial Setup (Creates first admin if none exists)
router.post('/api/setup', async (req, res) => {
    const { username, password } = req.body;
    const adminCount = await req.db.collection('admins').countDocuments();
    if (adminCount > 0) return res.status(403).json({ error: 'Admin already exists.' });
    
    const passwordHash = await bcrypt.hash(password, 10);
    await req.db.collection('admins').insertOne({ username, passwordHash, role: 'superadmin', createdAt: new Date() });
    res.json({ success: true, message: 'Admin created successfully.' });
});

// API: Login
router.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const admin = await req.db.collection('admins').findOne({ username });
    if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ adminId: admin._id }, JWT_SECRET, { expiresIn: '1d' });
    res.cookie('admin_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 86400000 });
    res.json({ success: true });
});

// API: Logout
router.post('/api/logout', (req, res) => {
    res.clearCookie('admin_token');
    res.json({ success: true });
});

// API: Get Appointments
router.get('/api/appointments', requireAuth, async (req, res) => {
    const appointments = await req.db.collection('appointments').find().sort({ startAt: -1 }).toArray();
    res.json(appointments);
});

// API: Update Appointment Status
router.put('/api/appointments/:id/status', requireAuth, async (req, res) => {
    const { ObjectId } = require('mongodb');
    const { status } = req.body;
    await req.db.collection('appointments').updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status, updatedAt: new Date() } }
    );
    res.json({ success: true });
});

// Admin Dashboard HTML/CSS/JS View
router.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Dashboard | SmileCraft Dental Care</title>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://unpkg.com/lucide@latest"></script>
    <style>
        :root {
            --primary: #27B8A5; --primary-dark: #159786; --secondary: #77C8F4;
            --accent: #FF8F87; --lavender: #DCD5FF; --bg: #F5F8FC; --surface: #FFFFFF;
            --text: #203047; --muted: #718096;
            --clay-shadow: 12px 12px 24px #d9e0e8, -12px -12px 24px #ffffff;
            --clay-inset: inset 6px 6px 12px #d9e0e8, inset -6px -6px 12px #ffffff;
            --clay-hover: 16px 16px 32px #d9e0e8, -16px -16px 32px #ffffff;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
        body { background-color: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }
        
        /* Utility Clay Classes */
        .clay-card { background: var(--surface); border-radius: 24px; box-shadow: var(--clay-shadow); padding: 2rem; transition: all 0.3s ease; }
        .clay-btn { background: var(--primary); color: white; border: none; border-radius: 16px; padding: 0.75rem 1.5rem; font-weight: 600; cursor: pointer; box-shadow: 6px 6px 12px #d9e0e8, -6px -6px 12px #ffffff; transition: all 0.2s; }
        .clay-btn:hover { background: var(--primary-dark); transform: translateY(-2px); box-shadow: var(--clay-hover); }
        .clay-input { width: 100%; background: var(--bg); border: none; border-radius: 16px; padding: 1rem; color: var(--text); box-shadow: var(--clay-inset); outline: none; margin-bottom: 1.5rem; }
        
        /* Layouts */
        .auth-container { display: flex; justify-content: center; align-items: center; min-height: 100vh; }
        .auth-box { width: 100%; max-width: 400px; text-align: center; }
        
        .dashboard-container { display: none; height: 100vh; }
        .sidebar { width: 280px; padding: 2rem; background: var(--surface); box-shadow: 12px 0 24px #d9e0e8; z-index: 10; display: flex; flex-direction: column; }
        .main-content { flex: 1; padding: 3rem; overflow-y: auto; }
        
        .nav-item { display: flex; align-items: center; gap: 1rem; padding: 1rem; border-radius: 16px; color: var(--muted); cursor: pointer; transition: all 0.2s; font-weight: 600; margin-bottom: 0.5rem; }
        .nav-item:hover, .nav-item.active { background: var(--bg); color: var(--primary); box-shadow: var(--clay-inset); }
        
        table { width: 100%; border-collapse: collapse; margin-top: 2rem; }
        th, td { padding: 1.2rem; text-align: left; border-bottom: 2px solid var(--bg); }
        th { color: var(--muted); font-weight: 600; }
        
        .status-badge { padding: 0.4rem 0.8rem; border-radius: 12px; font-size: 0.85rem; font-weight: 700; }
        .status-Pending { background: #fff3cd; color: #856404; }
        .status-Confirmed { background: #d4edda; color: #155724; }
        .status-Completed { background: var(--bg); color: var(--muted); }
        .status-Cancelled, .status-Rejected { background: #f8d7da; color: #721c24; }
        
        .action-select { padding: 0.5rem; border-radius: 8px; border: none; background: var(--bg); box-shadow: var(--clay-inset); outline: none; cursor: pointer; }
    </style>
</head>
<body>

    <!-- Auth View -->
    <div class="auth-container" id="authView">
        <div class="clay-card auth-box">
            <h2 style="margin-bottom: 0.5rem; color: var(--primary);">SmileCraft Admin</h2>
            <p style="margin-bottom: 2rem; color: var(--muted);" id="authSubtitle">Secure Login</p>
            <form id="authForm" onsubmit="handleAuth(event)">
                <input type="text" id="username" class="clay-input" placeholder="Username" required>
                <input type="password" id="password" class="clay-input" placeholder="Password" required>
                <button type="submit" class="clay-btn" style="width: 100%;" id="authBtn">Login</button>
            </form>
            <p id="authError" style="color: var(--accent); margin-top: 1rem; font-size: 0.9rem;"></p>
        </div>
    </div>

    <!-- Dashboard View -->
    <div class="dashboard-container" id="dashboardView">
        <div class="sidebar">
            <h2 style="color: var(--primary); margin-bottom: 3rem; display: flex; align-items: center; gap: 0.5rem;"><i data-lucide="tooth"></i> SmileCraft</h2>
            <div class="nav-item active"><i data-lucide="calendar"></i> Appointments</div>
            <div class="nav-item"><i data-lucide="users"></i> Patients (Demo)</div>
            <div style="margin-top: auto;" class="nav-item" onclick="handleLogout()"><i data-lucide="log-out"></i> Logout</div>
        </div>
        <div class="main-content">
            <h1 style="margin-bottom: 1rem;">Appointments Management</h1>
            <p style="color: var(--muted); margin-bottom: 2rem;">Manage incoming bookings and update their statuses.</p>
            <div class="clay-card">
                <table>
                    <thead>
                        <tr>
                            <th>Ref</th>
                            <th>Patient</th>
                            <th>Service</th>
                            <th>Date & Time</th>
                            <th>Status</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody id="appointmentsTableBody">
                        <tr><td colspan="6" style="text-align: center; color: var(--muted);">Loading...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        let isSetupMode = false;

        async function init() {
            lucide.createIcons();
            try {
                const res = await fetch('/admin/api/status');
                const data = await res.json();
                
                if (data.needsSetup) {
                    isSetupMode = true;
                    document.getElementById('authSubtitle').innerText = 'System Initial Setup';
                    document.getElementById('authBtn').innerText = 'Create Admin';
                } else if (data.isAuthenticated) {
                    showDashboard();
                }
            } catch (err) {
                console.error('Initialization failed', err);
            }
        }

        async function handleAuth(e) {
            e.preventDefault();
            const u = document.getElementById('username').value;
            const p = document.getElementById('password').value;
            const endpoint = isSetupMode ? '/admin/api/setup' : '/admin/api/login';
            
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: u, password: p })
                });
                const data = await res.json();
                
                if (data.success) {
                    if (isSetupMode) {
                        alert('Admin created successfully! Please log in.');
                        window.location.reload();
                    } else {
                        showDashboard();
                    }
                } else {
                    document.getElementById('authError').innerText = data.error || 'Authentication failed.';
                }
            } catch (err) {
                document.getElementById('authError').innerText = 'Server connection error.';
            }
        }

        async function handleLogout() {
            await fetch('/admin/api/logout', { method: 'POST' });
            window.location.reload();
        }

        function showDashboard() {
            document.getElementById('authView').style.display = 'none';
            document.getElementById('dashboardView').style.display = 'flex';
            loadAppointments();
        }

        async function loadAppointments() {
            const res = await fetch('/admin/api/appointments');
            const apps = await res.json();
            const tbody = document.getElementById('appointmentsTableBody');
            
            if(apps.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--muted);">No appointments found.</td></tr>';
                return;
            }

            tbody.innerHTML = apps.map(app => {
                const dt = new Date(app.startAt).toLocaleString('en-NP', { timeZone: 'Asia/Kathmandu', dateStyle: 'medium', timeStyle: 'short' });
                return \`
                    <tr>
                        <td style="font-weight: 600;">\${app.bookingReference}</td>
                        <td>
                            <div>\${app.patientName}</div>
                            <div style="font-size: 0.8rem; color: var(--muted);">\${app.patientPhone}</div>
                        </td>
                        <td>\${app.serviceName || 'General Consultation'}</td>
                        <td>\${dt}</td>
                        <td><span class="status-badge status-\${app.status}">\${app.status}</span></td>
                        <td>
                            <select class="action-select" onchange="updateStatus('\${app._id}', this.value)">
                                <option value="" disabled selected>Update...</option>
                                <option value="Confirmed">Confirm</option>
                                <option value="Completed">Complete</option>
                                <option value="Rejected">Reject</option>
                                <option value="Cancelled">Cancel</option>
                            </select>
                        </td>
                    </tr>
                \`;
            }).join('');
        }

        async function updateStatus(id, newStatus) {
            if(!confirm(\`Change status to \${newStatus}?\`)) return;
            await fetch(\`/admin/api/appointments/\${id}/status\`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus })
            });
            loadAppointments();
        }

        init();
    </script>
</body>
</html>
    `);
});

module.exports = router;