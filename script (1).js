// Storage key constants
const SAVEDINFO = "glamClubPosState";
const LOGIN_KEY = "TGC_LOGIN_STATE";
const TAB_KEY = "TGC_CURRENT_TAB";
const ROLE_KEY = "TGC_CURRENT_ROLE";
const USER_KEY = "TGC_CURRENT_USER";
const FULLNAME_KEY = "TGC_CURRENT_FULLNAME";
const LOCKOUT_KEY_PREFIX = "TGC_LOCKOUT_"; // Key for lockout logic

// Login lockout constants
const MAX_LOGIN_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 60 * 1000; // 60 seconds

// Runtime state variables
let isLoggedIn = false;
let currentUserRole = ""; // 'admin' or 'staff'
let currentUserName = "";
let currentUserFullName = "";
let selectedRoleLogin = null; // which role was chosen at login
let users = []; // user accounts
let inventory = [];
let purchaseHistory = [];
let auditLog = []; // audit entries
let currentOrder = { customerName: "", items: [], total: 0 };
let transactionCounter = 1000;

// Filter state
let currentInventoryFilters = { brand: "All", name: "All", type: "All", size: "All", color: "All" };
let currentOrderFilters = { brand: "All", name: "All", type: "All", size: "All", color: "All" };
let currentHistoryFilter = "All"; // 'All', 'pending', 'completed', 'refunded', 'cancelled'


// Save app data to localStorage
function saveState() {
    const state = {
        users,
        inventory,
        purchaseHistory,
        transactionCounter,
        auditLog // audit log
    };
    localStorage.setItem(SAVEDINFO, JSON.stringify(state));
}

// Download staff transactions as XLSX with auto-fitting columns
function downloadStaffTransactions(staffUsername) {
    const username = staffUsername || currentUserName;
    const staffReceipts = purchaseHistory.filter(p => p.staffUsername === username).sort((a,b) => new Date(b.date) - new Date(a.date));

    if (staffReceipts.length === 0) {
        showToast('No transactions to download.', 'info');
        return;
    }

    // Use same column format as admin audit export so staff downloads match
    const headers = ['TransactionID','LatestUpdate','StaffUsername','StaffName','EmployeeID','Customer','Status','Items','Amount'];
    const aoa = [headers];

    staffReceipts.forEach(r => {
        // Build plain-text items list and annotate refunded items
        let safeItems = '-';
        if (Array.isArray(r.items)) {
            safeItems = r.items.map(i => `${i.quantity}x ${i.brand || ''} - ${i.name || ''} (${i.type || ''}, ${i.size || ''}, ${i.color || ''})${i.refunded ? ' [REFUNDED]' : ''}`).join('\n');
        } else if (r.itemsText) {
            safeItems = r.itemsText;
        } else if (r.items) {
            safeItems = stripTags(r.items);
        }

        const staffUser = r.staffUsername || username;
        const staffObj = users.find(u => u.username === staffUser) || {};

        aoa.push([
            r.transactionID || '',
            r.date || '',
            staffUser,
            staffObj.firstName && staffObj.lastName ? `${staffObj.firstName} ${staffObj.lastName}` : (staffObj.firstName || staffObj.lastName || ''),
            staffObj.employeeId || '',
            r.customerName || '',
            r.status || '',
            safeItems,
            Number(r.subtotal || 0)
        ]);
    });

    const filename = `staff_transactions_${username}_${Date.now()}.xlsx`;

    if (typeof XLSX !== 'undefined') {
        const ws = XLSX.utils.aoa_to_sheet(aoa);

        // Calculate column widths
        const maxLens = new Array(headers.length).fill(0);
        aoa.forEach(row => {
            for (let c = 0; c < headers.length; c++) {
                const val = row[c] !== undefined && row[c] !== null ? String(row[c]) : '';
                maxLens[c] = Math.max(maxLens[c], Math.min(120, Math.ceil(val.length)));
            }
        });
        ws['!cols'] = maxLens.map(l => ({ wch: Math.max(10, Math.min(80, Math.ceil(l * 1.1))) }));

        // Enable text wrapping for 'Items' column
        const itemsColIndex = headers.indexOf('Items');
        if (itemsColIndex >= 0) {
            for (let r = 1; r < aoa.length; r++) {
                const cellAddr = XLSX.utils.encode_cell({ c: itemsColIndex, r });
                if (!ws[cellAddr]) ws[cellAddr] = { t: 's', v: String(aoa[r][itemsColIndex] || '') };
                else { ws[cellAddr].t = 's'; ws[cellAddr].v = String(aoa[r][itemsColIndex] || ''); }
                try {
                    ws[cellAddr].s = Object.assign(ws[cellAddr].s || {}, { alignment: Object.assign((ws[cellAddr].s && ws[cellAddr].s.alignment) || {}, { wrapText: true }) });
                } catch (e) { /* ignore */ }
            }
        }
        
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Staff Transactions');
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
        const blob = new Blob([wbout], { type: 'application/octet-stream' });
        
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showToast('Transactions XLSX downloaded.', 'success');
    }
}

// Generate a simple employee ID
function generateEmployeeID() {
    const prefix = "TGC-EMP-";
    // quick random 4-digit suffix (not collision-checked)
    const random = Math.floor(1000 + Math.random() * 9000); 
    return prefix + random;
}

// Check password rules
function validatePasswordStrict(password) {
    if (password.length < 12) {
        return "Password must be at least 12 characters long.";
    }
    
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSymbol = /[^A-Za-z0-9]/.test(password); // non-alphanumeric check

    if (!hasUpper || !hasLower || !hasNumber || !hasSymbol) {
        return "Password must include uppercase, lowercase, numbers, and symbols.";
    }
    return null; // valid
}

// Build HTML list for audit items
function generateAuditItemString(items) {
    if (!items || items.length === 0) return "-";
    const listItems = items.map(i => 
        `<li><b>${i.quantity}x</b> ${i.brand} - ${i.name} <span class="audit-item-details">(${i.type}, ${i.size}, ${i.color})</span></li>`
    ).join("");
    return `<ul class="audit-item-list">${listItems}</ul>`;
}

// Load state from storage or set default data
function loadState() {
    const savedState = localStorage.getItem(SAVEDINFO);
    if (savedState) {
        const state = JSON.parse(savedState);
        users = state.users || [];
        inventory = state.inventory;
        // Ensure all loaded receipts have a status
        purchaseHistory = state.purchaseHistory.map(p => ({
            ...p,
            status: p.status || 'completed'
        }));
        transactionCounter = state.transactionCounter;
        auditLog = state.auditLog || []; // Load audit log
        
        // If users don't have names, IDs, or contact info, add placeholders
        let usersUpdated = false;
        users.forEach((u, index) => {
            if (!u.firstName) {
                u.firstName = u.role === 'admin' ? 'Admin' : 'Staff';
                u.lastName = 'User';
                usersUpdated = true;
            }
            if (!u.employeeId) {
                u.employeeId = generateEmployeeID();
                usersUpdated = true;
            }
            if (!u.gender) {
                u.gender = "Not Specified";
                usersUpdated = true;
            }
            if (!u.contactNumber) {
                u.contactNumber = "N/A";
                usersUpdated = true;
            }
        });
        if (usersUpdated) saveState();

    } else {
        // Default Initial Data
        
        // Default Accounts
        users = [
            { 
                username: "justinesesbino6@gmail.com", 
                password: "GlamClub2025!", 
                role: "admin", 
                firstName: "Justine", 
                lastName: "Sesbino",
                gender: "Male",
                contactNumber: "09123456789",
                employeeId: "TGC-ADM-001"
            },
            { 
                username: "tilladokathrina@gmail.com", 
                password: "Ayokona123", 
                role: "staff", 
                firstName: "Kathrina", 
                lastName: "Tillado",
                gender: "Female",
                contactNumber: "09987654321",
                employeeId: "TGC-EMP-1002"
            },
            { 
                username: "shankerveyaldama@gmail.com", 
                password: "Yoohoo", 
                role: "staff", 
                firstName: "Shan", 
                lastName: "Aldama",
                gender: "Male",
                contactNumber: "09123456789",
                employeeId: "TGC-EMP-1003"
            },
            { 
                username: "lancebaldicanas06@gmail.com", 
                password: "naparabangangsarapsarap", 
                role: "staff", 
                firstName: "Lance", 
                lastName: "Baldicanas",
                gender: "Male",
                contactNumber: "09123356789",
                employeeId: "TGC-EMP-1004"
            },
        ];

        inventory = [
            { id: 1, name: "454", brand: "Kate Spade", type: "SHOULDER BAG", size: "L", color: "BLACK", price: 2500, quantity: 2, reorderPoint: 2 },
            { id: 2, name: "454", brand: "Kate Spade", type: "SHOULDER BAG", size: "S", color: "WARM", price: 2000, quantity: 11, reorderPoint: 2 },
            { id: 3, name: "454", brand: "Kate Spade", type: "SHOULDER BAG", size: "M", color: "BLACK", price: 2300, quantity: 8, reorderPoint: 2 },
            { id: 4, name: "454", brand: "Kate Spade", type: "SHOULDER BAG", size: "L", color: "R5Q", price: 2500, quantity: 7, reorderPoint: 2 },
            { id: 5, name: "AVA", brand: "Kate Spade", type: "CROSSBODY", size: "XL", color: "WXY", price: 3000, quantity: 12, reorderPoint: 2 },
            { id: 6, name: "AVA", brand: "Kate Spade", type: "CROSSBODY", size: "M", color: "WE5", price: 2000, quantity: 5, reorderPoint: 2 },
            { id: 7, name: "CAREY", brand: "Kate Spade", type: "SHOULDER BAG", size: "XL", color: "BLACK", price: 2500, quantity: 7, reorderPoint: 2 },
            { id: 8, name: "CAREY", brand: "Kate Spade", type: "SHOULDER BAG", size: "XXL", color: "BLACK", price: 3500, quantity: 8, reorderPoint: 2 },
            { id: 9, name: "DUET", brand: "Kate Spade", type: "CROSSBODY", size: "M", color: "BLACK", price: 2200, quantity: 4, reorderPoint: 2 },
            { id: 10, name: "DUET", brand: "Kate Spade", type: "CROSSBODY", size: "L", color: "VRV", price: 2500, quantity: 5, reorderPoint: 2 },
            { id: 11, name: "DUET", brand: "Kate Spade", type: "CROSSBODY", size: "XS", color: "BLACK", price: 1800, quantity: 6, reorderPoint: 2 },
            { id: 12, name: "DUET", brand: "Kate Spade", type: "CROSSBODY", size: "L", color: "WVW", price: 2500, quantity: 7, reorderPoint: 2 },
            { id: 13, name: "DUMPLING", brand: "Kate Spade", type: "SATCHEL", size: "XL", color: "BLACK", price: 4000, quantity: 7, reorderPoint: 2 },
            { id: 14, name: "DUMPLING", brand: "Kate Spade", type: "SATCHEL", size: "S", color: "WARM", price: 3200, quantity: 8, reorderPoint: 2 },
            { id: 15, name: "DUMPLING", brand: "Kate Spade", type: "SHOULDER BAG", size: "S", color: "R5Q", price: 2500, quantity: 4, reorderPoint: 2 },
            { id: 16, name: "DUMPLING", brand: "Kate Spade", type: "SHOULDER BAG", size: "M", color: "BLACK", price: 2800, quantity: 5, reorderPoint: 2 },
            { id: 17, name: "EMMA", brand: "Kate Spade", type: "SHOULDER BAG", size: "L", color: "COZY GREY", price: 3450, quantity: 6, reorderPoint: 2 },
            { id: 18, name: "KAYLA", brand: "Kate Spade", type: "CROSSBODY", size: "S", color: "VKS", price: 2300, quantity: 7, reorderPoint: 2 },
            { id: 19, name: "KAYLA", brand: "Kate Spade", type: "CROSSBODY", size: "M", color: "BLACKK", price: 2750, quantity: 4, reorderPoint: 2 },
            { id: 20, name: "KAYLA", brand: "Kate Spade", type: "CROSSBODY", size: "XL", color: "R5Q", price: 3800, quantity: 7, reorderPoint: 2 },
            { id: 21, name: "MADISON", brand: "Kate Spade", type: "FLAP SHOULDER", size: "L", color: "VKS", price: 2900, quantity: 5, reorderPoint: 2 },
            { id: 22, name: "MADISON", brand: "Kate Spade", type: "FLAP SHOULDER", size: "M", color: "BLACK", price: 2670, quantity: 6, reorderPoint: 2 },
            { id: 23, name: "MADISON", brand: "Kate Spade", type: "FLAP SHOULDER", size: "M", color: "VF6", price: 2670, quantity: 7, reorderPoint: 2 },
            { id: 24, name: "MADISON", brand: "Kate Spade", type: "FLAP SHOULDER", size: "L", color: "Y4V", price: 2900, quantity: 4, reorderPoint: 2 },
            { id: 25, name: "MADISON", brand: "Kate Spade", type: "SATCHEL", size: "M", color: "X4W", price: 2500, quantity: 3, reorderPoint: 2 },
            { id: 26, name: "MADISON", brand: "Kate Spade", type: "SATCHEL", size: "M", color: "VKS", price: 2500, quantity: 6, reorderPoint: 2 },
            { id: 27, name: "MADISON", brand: "Kate Spade", type: "CROSSBODY", size: "L", color: "BLACK", price: 3000, quantity: 7, reorderPoint: 2 },
            { id: 28, name: "MADISON", brand: "Kate Spade", type: "CROSSBODY", size: "XL", color: "BLACK", price: 3674, quantity: 5, reorderPoint: 2 },
            { id: 29, name: "MADISON", brand: "Kate Spade", type: "CROSSBODY", size: "XL", color: "X4W", price: 3674, quantity: 5, reorderPoint: 2 },
            { id: 30, name: "MADISON", brand: "Kate Spade", type: "CROSSBODY", size: "L", color: "UHV", price: 3000, quantity: 5, reorderPoint: 2 },
            { id: 31, name: "MADISON", brand: "Kate Spade", type: "CROSSBODY", size: "XL", color: "BLACK", price: 3674, quantity: 5, reorderPoint: 2 },
            { id: 32, name: "NOVA", brand: "Kate Spade", type: "CRES SHOULDER", size: "L", color: "BLACK", price: 3000, quantity: 5, reorderPoint: 2 },
            { id: 33, name: "NOVA", brand: "Kate Spade", type: "CRES SHOULDER", size: "M", color: "VKS", price: 2700, quantity: 5, reorderPoint: 2 },
            { id: 34, name: "OH SNAP", brand: "Kate Spade", type: "CROSSBODY", size: "S", color: "BLACK", price: 1500, quantity: 5, reorderPoint: 2 },
            { id: 35, name: "PERFECT TOTE", brand: "Kate Spade", type: "TOTE", size: "L", color: "R5K", price: 4000, quantity: 5, reorderPoint: 2 },
            { id: 36, name: "PERFECT TOTE", brand: "Kate Spade", type: "TOTE", size: "XL", color: "R5K", price: 4800, quantity: 5, reorderPoint: 2 },
            { id: 37, name: "PHOEBE", brand: "Kate Spade", type: "WALLET ON CHAIN", size: "M", color: "VRV", price: 1300, quantity: 5, reorderPoint: 2 },
            { id: 38, name: "PHOEBE", brand: "Kate Spade", type: "WALLET ON CHAIN", size: "S", color: "BLACK", price: 1200, quantity: 5, reorderPoint: 2 },
            { id: 39, name: "PHOEBE", brand: "Kate Spade", type: "WALLET ON CHAIN", size: "S", color: "BLACK", price: 1200, quantity: 5, reorderPoint: 2 },
            { id: 40, name: "SPADE FLOWER", brand: "Kate Spade", type: "TOTE", size: "M", color: "BLACK", price: 1250, quantity: 5, reorderPoint: 2 },
            { id: 41, name: "SPADE FLOWER", brand: "Kate Spade", type: "TOTE", size: "S", color: "WVW", price: 1100, quantity: 5, reorderPoint: 2 },
        ];
        // Clean up inventory data
        inventory.forEach(item => {
            let name = item.name;
            const sizeMatch = name.match(/\((L|M|S)\)$/i);
            if (sizeMatch) {
                item.size = sizeMatch[1].toUpperCase();
                name = name.replace(/\s*\((L|M|S)\)$/i, '').trim();
            } else if (!item.size) {
                item.size = "Std.";
            }
            const colorMatch = name.match(/-\s*([A-Z0-9\s]+)$/i);
            if (colorMatch && !item.color) {
                item.color = colorMatch[1].trim();
                name = name.replace(/-\s*([A-Z0-9\s]+)$/i, '').trim();
            } else if (!item.color) {
                item.color = "N/A";
            }
            item.name = name;
        });
        saveState();
    }
}

// Initialize app after DOM loads
document.addEventListener("DOMContentLoaded", () => {
    (async () => { await loadState(); await migrateUserPasswords(); })();
    
    // Check login persistence
    const savedLoginState = localStorage.getItem(LOGIN_KEY);
    const savedRole = localStorage.getItem(ROLE_KEY);
    const savedUser = localStorage.getItem(USER_KEY);
    const savedFullName = localStorage.getItem(FULLNAME_KEY);
    
    if (savedLoginState === "true") {
        // Restore session variables
        currentUserRole = savedRole;
        currentUserName = savedUser;
        currentUserFullName = savedFullName;
        isLoggedIn = true;

        // Update UI to bypass login
        const loginScreen = document.getElementById("loginScreen");
        const appContainer = document.querySelector(".appContainer");
        
        loginScreen.classList.add("hidden");
        loginScreen.style.display = "none"; 
        appContainer.classList.remove("hidden");
        const hb = document.getElementById('hamburgerBtn'); if (hb) hb.style.display = '';
        
        updateSidebarVisibility();

        // Restore last active tab or default to dashboard
        const lastTab = localStorage.getItem(TAB_KEY) || "dashboard";
        showSection(lastTab);
        
        updateDashboardWidgets();
        renderInventory();
    } 

    else {
        // Ensure role selection is visible when no active session to avoid flicker
        const rolePanel = document.getElementById("roleSelectionPanel");
        const loginForm = document.getElementById("loginFormBlock");
        if (rolePanel) rolePanel.classList.remove('hidden');
        if (loginForm) loginForm.classList.add('hidden');
            const hb = document.getElementById('hamburgerBtn'); if (hb) hb.style.display = 'none'; // Hide hamburger button initially
    }

    document.getElementById("mainPassword").addEventListener("keyup", function(event) {
        if (event.key === "Enter") {
            handleMainLogin();
        }
    });

    try { ensureToggleIcons(); } catch (e) { /* ignore */ }

    // Attach centralized error handler to logo images
    try {
        document.querySelectorAll('img.logo').forEach(img => {
            img.onerror = function() {
                try {
                    this.style.display = 'none';
                } catch (e) {}
                if (!this.nextElementSibling || !this.nextElementSibling.classList.contains('logo-placeholder')) {
                    this.insertAdjacentHTML('afterend', '<div class="logo-placeholder">TGC</div>');
                }
            };
        });
    } catch (e) {
        // ignore if DOM not ready or querySelectorAll fails
    }
});

// Toggle password input visibility
function togglePasswordVisibility(inputId, iconElement) {
    const input = document.getElementById(inputId);
    if (input.type === "password") {
        input.type = "text";
        iconElement.classList.remove("fa-eye");
        iconElement.classList.add("fa-eye-slash");
    } else {
        input.type = "password";
        iconElement.classList.remove("fa-eye-slash");
        iconElement.classList.add("fa-eye");
    }
}

// Ensure any `.password-wrapper` has a visible toggle icon (useful when HTML is injected)
function ensureToggleIcons() {
    document.querySelectorAll('.password-wrapper').forEach(wrapper => {
        const input = wrapper.querySelector('input[type="password"], input');
        if (!input) return;
        // If a toggle already exists, ensure it has a data-target for delegated handler
        let toggle = wrapper.querySelector('.toggle-password');
        if (!toggle) {
            // ensure input has an id for targeting
            if (!input.id) input.id = 'pw_' + Math.random().toString(36).slice(2, 9);
            toggle = document.createElement('i');
            toggle.className = 'fas fa-eye toggle-password';
            toggle.setAttribute('data-target', input.id);
            // allow keyboard accessibility
            toggle.setAttribute('role', 'button');
            toggle.setAttribute('tabindex', '0');
            wrapper.appendChild(toggle);
        } else {
            if (!toggle.getAttribute('data-target')) {
                if (!input.id) input.id = 'pw_' + Math.random().toString(36).slice(2, 9);
                toggle.setAttribute('data-target', input.id);
            }
        }
    });
}

// Show/hide admin button based on role
function updateSidebarVisibility() {
    const adminBtn = document.getElementById("navAdminBtn");
    
    if (currentUserRole === 'admin') {
        adminBtn.classList.remove("hidden");
    } else {
        adminBtn.classList.add("hidden");
    }
}

// Show a short toast notification (bottom-right)
function showToast(message, type = 'info', duration = 3000) {
    try {
        const container = document.getElementById('toastContainer');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<span class="toast-icon">${type === 'success' ? '<i class="fas fa-check-circle"></i>' : type === 'error' ? '<i class="fas fa-exclamation-circle"></i>' : '<i class="fas fa-info-circle"></i>'}</span><div class="toast-message">${message}</div>`;
        container.appendChild(toast);

        // Auto-remove after duration
        setTimeout(() => {
            toast.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(6px)';
            setTimeout(() => container.removeChild(toast), 260);
        }, duration);
    } catch (e) {
        // Fallback: silent
        console.error('Toast error', e);
    }
}

// Toggle sidebar open/closed
function toggleSidebar() {
    const app = document.querySelector('.appContainer');
    if (!app) return;
    app.classList.toggle('sidebar-collapsed');
}

// Step 1: Show Login Form based on role selection
function showLoginForm(role) {
    selectedRoleLogin = role;
    document.getElementById("roleSelectionPanel").classList.add("hidden");
    document.getElementById("loginFormBlock").classList.remove("hidden");
    
    // Set display text
    const displayRole = role.charAt(0).toUpperCase() + role.slice(1);
    document.getElementById("loginRoleDisplay").textContent = `Logging in as ${displayRole}`;
    
    // Clear previous error
    document.getElementById("loginError").classList.add("hidden");
    document.getElementById("mainUsername").focus();
}

// Go back to role selection
function backToRoleSelection() {
    selectedRoleLogin = null;
    document.getElementById("loginFormBlock").classList.add("hidden");
    document.getElementById("roleSelectionPanel").classList.remove("hidden");
    document.getElementById("mainUsername").value = "";
    document.getElementById("mainPassword").value = "";
}

// Handle Main Login
async function handleMainLogin() {
    const userIn = document.getElementById("mainUsername").value.trim();
    const passIn = document.getElementById("mainPassword").value.trim();
    const errorDiv = document.getElementById("loginError");

    if (!userIn) {
        errorDiv.textContent = "Please enter a username.";
        errorDiv.classList.remove("hidden");
        return;
    }

    // --- LOCKOUT CHECK ---
    const lockoutKey = LOCKOUT_KEY_PREFIX + userIn;
    const lockoutData = JSON.parse(localStorage.getItem(lockoutKey) || "{}");
    const now = Date.now();

    if (lockoutData.lockoutUntil && now < lockoutData.lockoutUntil) {
        const remainingSeconds = Math.ceil((lockoutData.lockoutUntil - now) / 1000);
        errorDiv.textContent = `Account locked. Try again in ${remainingSeconds}s.`;
        errorDiv.classList.remove("hidden");
        return;
    }

    // Find user in the list using secure hash comparison if available (legacy plaintext fallback supported)
    const hashedInput = await hashPassword(passIn);
    const foundUser = users.find(u => u.username === userIn && ((u.passwordHash && u.passwordHash === hashedInput) || (u.password && u.password === passIn)));

    // If this is a legacy account using plaintext password and it matched, migrate to hashed storage
    if (foundUser && foundUser.password && foundUser.password === passIn) {
        try {
            foundUser.passwordHash = hashedInput;
            delete foundUser.password;
            saveState();
        } catch (e) { console.warn('Migration to hashed password failed', e); }
    }

    if (foundUser) {
        // Check if role matches selection
        if (foundUser.role !== selectedRoleLogin) {
             errorDiv.textContent = `Account not authorized for ${selectedRoleLogin} login.`;
             errorDiv.classList.remove("hidden");
             return;
        }

        // Successful Login - Clear Lockout Data
        localStorage.removeItem(lockoutKey);

        currentUserRole = foundUser.role;
        currentUserName = foundUser.username;
        currentUserFullName = (foundUser.firstName && foundUser.lastName) 
            ? `${foundUser.firstName} ${foundUser.lastName}` 
            : "Personnel";

        isLoggedIn = true;
        
        errorDiv.classList.add("hidden");

        // Save Persistence
        localStorage.setItem(LOGIN_KEY, "true");
        localStorage.setItem(ROLE_KEY, currentUserRole);
        localStorage.setItem(USER_KEY, currentUserName);
        localStorage.setItem(FULLNAME_KEY, currentUserFullName);

        const loginScreen = document.getElementById("loginScreen");
        const appContainer = document.querySelector(".appContainer");

        loginScreen.style.opacity = "0";
        setTimeout(() => {
            loginScreen.classList.add("hidden");
            loginScreen.style.display = "none";
        }, 500);

        appContainer.classList.remove("hidden");
        const hb = document.getElementById('hamburgerBtn'); if (hb) hb.style.display = '';
        
        updateSidebarVisibility();
        showSection("dashboard");
        updateDashboardWidgets();
        renderInventory();
    } else {
        // Failed Attempt Logic
        if (users.some(u => u.username === userIn)) {
            // User exists but password wrong
            let attempts = (lockoutData.attempts || 0) + 1;
            
            if (attempts >= MAX_LOGIN_ATTEMPTS) {
                // Trigger Lockout
                const lockoutUntil = now + LOCKOUT_DURATION_MS;
                localStorage.setItem(lockoutKey, JSON.stringify({ attempts: attempts, lockoutUntil: lockoutUntil }));
                errorDiv.textContent = `Too many failed attempts. Account locked for 60s.`;
            } else {
                // Increment Attempts
                localStorage.setItem(lockoutKey, JSON.stringify({ attempts: attempts }));
                errorDiv.textContent = `Invalid credentials. ${MAX_LOGIN_ATTEMPTS - attempts} attempts remaining.`;
            }
        } else {
            // Username doesn't exist, generic message
            errorDiv.textContent = "Invalid credentials. Please try again.";
        }
        
        errorDiv.classList.remove("hidden");
    }
}

// Logout Function
function logout() {
    // Clear persistence
    localStorage.removeItem(LOGIN_KEY);
    localStorage.removeItem(TAB_KEY);
    localStorage.removeItem(ROLE_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(FULLNAME_KEY);
    
    // Reset internal state
    isLoggedIn = false; 
    currentUserRole = "";
    currentUserName = "";
    currentUserFullName = "";
    selectedRoleLogin = null;

    // Reset Main Login Inputs
    document.getElementById("mainUsername").value = "";
    document.getElementById("mainPassword").value = "";
    document.getElementById("loginError").classList.add("hidden");
    
    // Reset UI to Role Selection
    document.getElementById("loginFormBlock").classList.add("hidden");
    document.getElementById("roleSelectionPanel").classList.remove("hidden");

    // Hide App, Show Login
    const loginScreen = document.getElementById("loginScreen");
    const appContainer = document.querySelector(".appContainer");

    appContainer.classList.add("hidden");
    loginScreen.classList.remove("hidden");
    loginScreen.style.display = "flex"; 
    const hb = document.getElementById('hamburgerBtn'); if (hb) hb.style.display = 'none';
    
    setTimeout(() => {
        loginScreen.style.opacity = "1";
    }, 10);
}

// Shows one section of the app
function showSection(sectionId) {
    // Close any open modals (like reports) when navigating
    closeModal();

    // Guard check for admin section
    if (sectionId === 'admin' && currentUserRole !== 'admin') {
        showModalMessage("Access Denied", "You do not have permission to view this section.");
        return;
    }

    document.querySelectorAll("main section").forEach(section => {
        section.classList.remove("active");
    });
    
    const activeSection = document.getElementById(sectionId);
    if(activeSection) {
        activeSection.classList.add("active");
        localStorage.setItem(TAB_KEY, sectionId);

        switch(sectionId) {
            case "dashboard": updateDashboardWidgets(); break;
            case "profile": renderProfile(); break;
            case "inventory": 
                currentInventoryFilters = { brand: "All", name: "All", type: "All", size: "All", color: "All" };
                renderInventory(); 
                break;
            case "order":
                currentOrderFilters = { brand: "All", name: "All", type: "All", size: "All", color: "All" };
                renderOrderScreen();
                break;
            case "history":
                 document.getElementById("historySearchInput").value = "";
                 // Default to All when opening history
                 setHistoryFilter('All', document.querySelector('.filterTag')); 
                break;
        }
    }
}

// Updates the summary boxes
function updateDashboardWidgets() {
    // Update Welcome Message
    const welcomeEl = document.getElementById("welcomeMessage");
    if (welcomeEl) {
        welcomeEl.textContent = `Welcome, ${currentUserFullName}`;
    }

    document.getElementById("widgetTotalProducts").textContent = inventory.length;
    const lowStockCount = inventory.filter(item => item.quantity <= item.reorderPoint).length;
    document.getElementById("widgetLowStock").textContent = lowStockCount;
    
    const today = new Date().toLocaleDateString("en-CA");
    // Only count completed sales for revenue.
    // Admin sees overall totals; staff sees only their own processed transactions.
    let todaysSales = [];
    if (currentUserRole === 'admin') {
        todaysSales = purchaseHistory.filter(p => p.date === today && p.status === 'completed');
    } else {
        todaysSales = purchaseHistory.filter(p => p.date === today && p.status === 'completed' && p.staffUsername === currentUserName);
    }

    const itemsSold = todaysSales.reduce((sum, sale) => sum + (sale.items ? sale.items.reduce((itemSum, item) => itemSum + item.quantity, 0) : 0), 0);
    const revenue = todaysSales.reduce((sum, sale) => sum + (sale.subtotal || 0), 0);

    document.getElementById("widgetItemsSold").textContent = itemsSold;
    document.getElementById("widgetRevenue").textContent = `₱${revenue.toFixed(2)}`;
}

// --- PROFILE SECTION LOGIC ---
function renderProfile() {
    const user = users.find(u => u.username === currentUserName);
    const profileContainer = document.getElementById("userProfileDisplay");

    profileContainer.innerHTML = '';
    if (!user) {
        profileContainer.textContent = 'User details not found.';
        return;
    }

    const card = document.createElement('div');
    card.className = 'profileCard';

    const header = document.createElement('div');
    header.className = 'profileHeader';

    const avatar = document.createElement('div');
    avatar.className = 'profileAvatar';
    const avatarIcon = document.createElement('i');
    avatarIcon.className = 'fas fa-user';
    avatar.appendChild(avatarIcon);

    const nameEl = document.createElement('h3');
    nameEl.textContent = `${user.firstName || ''} ${user.lastName || ''}`.trim();

    const roleEl = document.createElement('span');
    roleEl.className = `profileRole ${user.role}`;
    roleEl.textContent = (user.role || '').toUpperCase();

    header.appendChild(avatar);
    header.appendChild(nameEl);
    header.appendChild(roleEl);

    const details = document.createElement('div');
    details.className = 'profileDetails';

    function makeRow(labelText, valueText) {
        const row = document.createElement('div');
        row.className = 'detailRow';
        const label = document.createElement('span');
        label.className = 'detailLabel';
        label.textContent = labelText;
        const value = document.createElement('span');
        value.className = 'detailValue';
        value.textContent = valueText || 'N/A';
        row.appendChild(label);
        row.appendChild(value);
        return row;
    }

    details.appendChild(makeRow('\u{1F4BC} Employee ID:', user.employeeId || 'N/A'));
    details.appendChild(makeRow('\u{2640}\u{2642} Gender:', user.gender || 'Not Specified'));
    details.appendChild(makeRow('\u{1F4DE} Contact Number:', user.contactNumber || 'N/A'));
    details.appendChild(makeRow('\u{2709} Username:', user.username));

    const actions = document.createElement('div');
    actions.className = 'profileActions';
    const changeBtn = document.createElement('button');
    changeBtn.className = 'btnPrimary';
    changeBtn.onclick = openChangePasswordModal;
    changeBtn.innerHTML = '<i class="fas fa-key"></i> Change Password';
    actions.appendChild(changeBtn);

    if (user.role === 'staff') {
        const mine = document.createElement('button');
        mine.className = 'btnSecondary';
        mine.style.marginLeft = '8px';
        mine.textContent = 'My Transactions';
        mine.onclick = showStaffAuditTrail;
        actions.appendChild(mine);
    }
    if (user.role === 'admin') {
        const aud = document.createElement('button');
        aud.className = 'btnSecondary';
        aud.style.marginLeft = '8px';
        aud.textContent = 'View Audit Trail';
        aud.onclick = showAuditTrail;
        actions.appendChild(aud);
    }

    card.appendChild(header);
    card.appendChild(details);
    card.appendChild(actions);
    profileContainer.appendChild(card);
}

function openChangePasswordModal() {
    const modalContent = `
        <div class="modalHeader"><h3>Change Password</h3><button class="modalCloseBtn" onclick="closeModal()"></button></div>
        <div class="formGroup">
            <label>Current Password:</label>
            <div class="password-wrapper">
                <input type="password" id="currentPassword" placeholder="Enter current password">
                <i class="fas fa-eye toggle-password"></i>
            </div>
        </div>
        <div class="formGroup">
            <label>New Password:</label>
            <div class="password-wrapper">
                <input type="password" id="newPassword" placeholder="Enter new password">
                <i class="fas fa-eye toggle-password"></i>
            </div>
        </div>
        <p style="font-size: 0.8rem; color: #777; margin-bottom: 1rem;">
            Password must be at least 12 characters long and include uppercase, lowercase, numbers, and symbols.
        </p>
        <div class="modalFooter">
            <button class="btnSecondary" onclick="closeModal()">Cancel</button>
            <button class="btnPrimary" onclick="processChangePassword()">Update Password</button>
        </div>
    `;
    showModal(modalContent);
}

async function processChangePassword() {
    const currentPass = document.getElementById("currentPassword").value;
    const newPass = document.getElementById("newPassword").value;

    const user = users.find(u => u.username === currentUserName);

    const currentHash = await hashPassword(currentPass);
    if (!((user.passwordHash && user.passwordHash === currentHash) || (user.password && user.password === currentPass))) {
        showModalMessage("Error", "Current password is incorrect.");
        return;
    }

    const validationError = validatePasswordStrict(newPass);
    if (validationError) {
        showModalMessage("Weak Password", validationError);
        return;
    }

    user.passwordHash = await hashPassword(newPass);
    if (user.password) delete user.password;
    saveState();
    closeModal();
    showModalMessage("Success", "Password updated successfully.");
    renderProfile(); // Refresh profile view
}

// --- ADMIN ACTION HELPER ---
// Runs a function only if the user is admin.
function adminAction(callback) {
    if (currentUserRole !== 'admin') {
        showModalMessage("Access Denied", "You must be an admin to perform this action.");
        return;
    }
    callback();
}

// --- USER REGISTRATION & MANAGEMENT LOGIC ---

function openRegisterUserModal() {
    adminAction(() => {
         const modalContent = `
            <div class="modalHeader"><h3>Register New User</h3><button class="modalCloseBtn" onclick="closeModal()"></button></div>
            <div class="formGrid">
                 <div class="formGroup">
                    <label>First Name:</label>
                    <input type="text" id="regFirstName" placeholder="First Name">
                </div>
                 <div class="formGroup">
                    <label>Surname:</label>
                    <input type="text" id="regSurname" placeholder="Surname">
                </div>
                <div class="formGroup">
                    <label>Gender:</label>
                     <select id="regGender">
                        <option value="Male">Male</option>
                        <option value="Female">Female</option>
                    </select>
                </div>
                <div class="formGroup">
                    <label>Contact Number:</label>
                    <input type="text" id="regContact" placeholder="e.g. 09123456789" oninput="this.value = this.value.replace(/[^0-9]/g, '').slice(0, 11)">
                </div>
                <div class="formGroup">
                    <label>Username:</label>
                    <input type="text" id="regUsername" placeholder="Enter unique username">
                </div>
                <div class="formGroup">
                    <label>Password:</label>
                    <div class="password-wrapper">
                        <input type="password" id="regPassword" placeholder="Enter password">
                        <i class="fas fa-eye toggle-password"></i>
                    </div>
                </div>
                <div class="formGroup">
                    <label>Role:</label>
                    <select id="regRole">
                        <option value="staff">Staff</option>
                        <option value="admin">Admin</option>
                    </select>
                </div>
            </div>
            <p style="font-size: 0.8rem; color: #777; margin-bottom: 1rem;">
                Password requirement: Min 12 chars, include Upper/Lower/Number/Symbol.
            </p>
            <div class="modalFooter">
                <button class="btnSecondary" onclick="closeModal()">Cancel</button>
                <button class="btnPrimary" onclick="processRegisterUser()">Create Account</button>
            </div>
        `;
        showModal(modalContent);
    });
}

async function processRegisterUser() {
    const firstName = document.getElementById("regFirstName").value.trim();
    const lastName = document.getElementById("regSurname").value.trim();
    const gender = document.getElementById("regGender").value;
    const contact = document.getElementById("regContact").value.trim();
    const userIn = document.getElementById("regUsername").value.trim();
    const passIn = document.getElementById("regPassword").value.trim();
    const roleIn = document.getElementById("regRole").value;

    if (!userIn || !passIn || !firstName || !lastName || !contact) {
        showModalMessage("Error", "All fields are required.");
        return;
    }

    if (contact.length !== 11) {
        showModalMessage("Error", "Contact number must be exactly 11 digits.");
        return;
    }

    const validationError = validatePasswordStrict(passIn);
    if (validationError) {
        showModalMessage("Weak Password", validationError);
        return;
    }

    // Check if username exists
    if (users.some(u => u.username === userIn)) {
        showModalMessage("Error", "Username already exists. Please choose another.");
        return;
    }

    const newId = generateEmployeeID();

    const passHash = await hashPassword(passIn);
    users.push({
        username: userIn,
        passwordHash: passHash,
        role: roleIn,
        firstName: firstName,
        lastName: lastName,
        gender: gender,
        contactNumber: contact,
        employeeId: newId
    });
    
    saveState();
    closeModal();
    showModalMessage("Success", `User "${firstName} ${lastName}" created successfully.\nID: ${newId}`);
}

function openRemoveUserModal() {
    adminAction(() => {
        // Filter out the currently logged-in user to prevent self-deletion
        const deletableUsers = users.filter(u => u.username !== currentUserName);
        
        let options = "";
        if (deletableUsers.length === 0) {
            options = "<option value=''>No other users to remove</option>";
        } else {
            options = deletableUsers.map(u => `<option value="${u.username}">${u.firstName} ${u.lastName} (${u.role}) - ${u.username}</option>`).join("");
        }

        const modalContent = `
            <div class="modalHeader"><h3>Remove User</h3><button class="modalCloseBtn" onclick="closeModal()"></button></div>
            <div class="formGroup">
                <label>Select User to Remove:</label>
                <select id="removeUserSelect">
                    <option value="">-- Select a user --</option>
                    ${options}
                </select>
            </div>
            <p><strong>Note:</strong> You cannot remove your own account while logged in.</p>
            <div class="modalFooter">
                <button class="btnSecondary" onclick="closeModal()">Cancel</button>
                <button class="btnPrimary" style="background-color: #d9534f;" onclick="processRemoveUser()">Confirm Removal</button>
            </div>
        `;
        showModal(modalContent);
    });
}

function processRemoveUser() {
    const userSelect = document.getElementById("removeUserSelect");
    const usernameToRemove = userSelect.value;

    if (!usernameToRemove) {
        showModalMessage("Error", "Please select a user to remove.");
        return;
    }

    const userToRemove = users.find(u => u.username === usernameToRemove);
    if (userToRemove) {
        users = users.filter(u => u.username !== usernameToRemove);
        saveState();
        closeModal();
        showModalMessage("Success", `User "${userToRemove.firstName} ${userToRemove.lastName}" has been removed.`);
    } else {
        showModalMessage("Error", "User not found.");
    }
}


// --- INVENTORY FILTER LOGIC ---

function updateInventoryFilter(key, value) {
    currentInventoryFilters[key] = value;
    renderInventory();
}

// Helper to populate select dropdowns
function setupFilters(items, prefix) {
    const filters = prefix === 'inventory' ? currentInventoryFilters : currentOrderFilters;

    // Helper to fill a specific select
    const fill = (key, subset) => {
        const select = document.getElementById(`${prefix}Filter${key.charAt(0).toUpperCase() + key.slice(1)}`);
        if(!select) return;
        const unique = ["All", ...new Set(subset.map(i => i[key]))];
        select.innerHTML = unique.map(u => `<option value="${u}">${u}</option>`).join("");
        if (!unique.includes(filters[key])) filters[key] = "All";
        select.value = filters[key];
    };

    const f = items.filter(i => (prefix === 'inventory' ? true : i.quantity > 0)); // Order screen only shows in-stock

    // Cascade logic (Brand -> Name -> Type -> Size -> Color)
    fill('brand', f);
    const byBrand = f.filter(i => filters.brand === "All" || i.brand === filters.brand);

    fill('name', byBrand);
    const byName = byBrand.filter(i => filters.name === "All" || i.name === filters.name);

    fill('type', byName);
    const byType = byName.filter(i => filters.type === "All" || i.type === filters.type);

    fill('size', byType);
    const bySize = byType.filter(i => filters.size === "All" || i.size === filters.size);

    fill('color', bySize);
}

function populateInventoryFilters() {
    setupFilters(inventory, 'inventory');
}

function renderInventory() {
    const inventoryList = document.getElementById("inventoryList");
    inventoryList.innerHTML = "";
    populateInventoryFilters();

    let filteredInventory = inventory.filter(item => {
        const matchesBrand = currentInventoryFilters.brand === "All" || item.brand === currentInventoryFilters.brand;
        const matchesType = currentInventoryFilters.type === "All" || item.type === currentInventoryFilters.type;
        const matchesSize = currentInventoryFilters.size === "All" || item.size === currentInventoryFilters.size;
        const matchesColor = currentInventoryFilters.color === "All" || item.color === currentInventoryFilters.color;
        const matchesName = currentInventoryFilters.name === "All" || 
                              item.name === currentInventoryFilters.name;
        return matchesBrand && matchesType && matchesSize && matchesColor && matchesName;
    });

    if (filteredInventory.length === 0) {
        inventoryList.innerHTML = `<p class="emptyMessage">No items match the current filters.</p>`;
        return;
    }

    filteredInventory.forEach(item => {
        const itemCard = document.createElement("div");
        itemCard.className = "inventoryItem";
        itemCard.innerHTML = `
            <div class="itemDetails">
                <h3>${item.name}</h3>
                <p class="itemMeta">${item.brand} - ${item.type}</p>
                <p class="itemMeta">Color: ${item.color} | Size: ${item.size}</p>
                <p class="itemPrice">₱${item.price.toFixed(2)}</p>
                <span class="itemStock ${item.quantity <= item.reorderPoint ? "low" : ""}">
                    Stock: ${item.quantity}
                </span>
            </div>
        `;
        inventoryList.appendChild(itemCard);
    });
}

// --- ORDER FILTER LOGIC ---

function updateOrderFilter(key, value) {
    currentOrderFilters[key] = value;
    renderOrderScreen();
}

function populateOrderFilters() {
    setupFilters(inventory, 'order');
}

function renderOrderScreen() {
    const productList = document.getElementById("orderProductList");
    productList.innerHTML = "";
    populateOrderFilters();

    const availableProducts = inventory.filter(item => {
        const matchesStock = item.quantity > 0;
        const matchesBrand = currentOrderFilters.brand === "All" || item.brand === currentOrderFilters.brand;
        const matchesType = currentOrderFilters.type === "All" || item.type === currentOrderFilters.type;
        const matchesSize = currentOrderFilters.size === "All" || item.size === currentOrderFilters.size;
        const matchesColor = currentOrderFilters.color === "All" || item.color === currentOrderFilters.color;
        const matchesName = currentOrderFilters.name === "All" || 
                              item.name === currentOrderFilters.name;
        return matchesStock && matchesBrand && matchesType && matchesSize && matchesColor && matchesName;
    });

    if (availableProducts.length === 0) {
        productList.innerHTML = `<p class="emptyMessage">No products match the current filters.</p>`;
    } else {
        availableProducts.forEach(item => {
            const itemCard = document.createElement("div");
            itemCard.className = "inventoryItem";
            itemCard.onclick = () => addToCart(item.id);
            itemCard.innerHTML = `
                <div class="itemDetails">
                    <h3>${item.name}</h3>
                    <p class="itemMeta">${item.brand} | ${item.type}</p>
                    <p class="itemMeta">Color: ${item.color} | Size: ${item.size}</p>
                    <p class="itemPrice">₱${item.price.toFixed(2)}</p>
                    <span class="itemStock">Stock: ${item.quantity}</span>
                </div>
            `;
            productList.appendChild(itemCard);
        });
    }
    renderCart();
}

// --- CART & CHECKOUT LOGIC ---

function addToCart(itemId) {
    const itemInInventory = inventory.find(i => i.id === itemId);
    if (!itemInInventory || itemInInventory.quantity <= 0) {
        showModalMessage("Out of Stock", "This item is currently unavailable.");
        return;
    }
    const itemInCart = currentOrder.items.find(i => i.id === itemId);
    if (itemInCart) {
        if (itemInCart.quantity < itemInInventory.quantity) {
            itemInCart.quantity++;
            showToast(`${itemInInventory.name} quantity increased in cart.`, 'info');
        } else {
            showModalMessage("Stock Limit", `Cannot add more than the available stock of ${itemInInventory.quantity}.`);
        }
    } else {
        currentOrder.items.push({
            id: itemId, 
            name: itemInInventory.name, 
            price: itemInInventory.price, 
            quantity: 1,
            size: itemInInventory.size,
            color: itemInInventory.color,
            brand: itemInInventory.brand,
            type: itemInInventory.type  
        });
        showToast(`${itemInInventory.name} added to cart.`, 'success');
    }
    renderCart();
}

function updateCartQuantity(itemId, newQuantity) {
    const itemInCart = currentOrder.items.find(i => i.id === itemId);
    const itemInInventory = inventory.find(i => i.id === itemId);
    if (!itemInCart || !itemInInventory) return;
    
    const quantity = Math.max(0, Math.min(newQuantity, itemInInventory.quantity));
    
    if (quantity === 0) {
        removeFromCart(itemId);
    } else {
        itemInCart.quantity = quantity;
    }
    renderCart();
}

function removeFromCart(itemId) {
    currentOrder.items = currentOrder.items.filter(i => i.id !== itemId);
    renderCart();
}

function renderCart() {
    const cartItemsDiv = document.getElementById("cartItems");
    cartItemsDiv.innerHTML = "";
    
    if (currentOrder.items.length === 0) {
        cartItemsDiv.innerHTML = '<p class="emptyCartMsg">Your cart is empty.</p>';
    } else {
        currentOrder.items.forEach(item => {
            const cartItemEl = document.createElement("div");
            cartItemEl.className = "cartItem";
            cartItemEl.innerHTML = `
                <div class="cartItemInfo">
                    <span class="itemName">${item.name}</span>
                    <span class="itemMetaSmall">Size: ${item.size} | Color: ${item.color}</span>
                    <span class="itemPrice">₱${item.price.toFixed(2)}</span>
                </div>
                <div class="cartItemQty">
                    <input type="number" value="${item.quantity}" min="1" onchange="updateCartQuantity(${item.id}, this.valueAsNumber)">
                </div>
                <button class="removeBtn" onclick="removeFromCart(${item.id})"><i class="fas fa-times-circle"></i></button>
            `;
            cartItemsDiv.appendChild(cartItemEl);
        });
    }
    
    currentOrder.total = currentOrder.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    document.getElementById("cartTotal").textContent = `₱${currentOrder.total.toFixed(2)}`;
}

function handleCheckout() {
    const customerName = document.getElementById("customerName").value.trim();
    if (!customerName) {
        showModalMessage("Customer Name Required", "Please enter the customer's name to proceed.");
        return;
    }
    if (currentOrder.items.length === 0) {
        showModalMessage("Empty Cart", "Please add items to the cart before checking out.");
        return;
    }

    currentOrder.customerName = customerName;

    // Updated Modal Content to include "Mark as To Pay"
    const modalContent = `
        <div class="modalHeader"><h3>Payment</h3><button class="modalCloseBtn" onclick="closeModal()"></button></div>
        <p>Total Amount Due: <strong>₱${currentOrder.total.toFixed(2)}</strong></p>
        <div class="formGroup">
            <label for="paymentAmount">Enter Payment Amount:</label>
            <input type="number" id="paymentAmount" step="0.01" placeholder="0.00">
        </div>
        <div class="modalFooter">
            <button class="btnSecondary" onclick="closeModal()">Cancel</button>
            <div class="btnGroup">
                <button class="btnSecondary" style="background-color: #e67e22; color: white; border:none;" onclick="processToPay()">Mark as To Pay</button>
                <button class="btnPrimary" onclick="processPayment()">Confirm Payment</button>
            </div>
        </div>
    `;
    showModal(modalContent);
    document.getElementById("paymentAmount").focus();
}

function processToPay() {
    // Handles the "To Pay" scenario: Stock deducted, but payment is 0 and status is pending
    
    // Deduct stock
    currentOrder.items.forEach(cartItem => {
        const inventoryItem = inventory.find(invItem => invItem.id === cartItem.id);
        if (inventoryItem) {
            inventoryItem.quantity -= cartItem.quantity;
        }
    });

    transactionCounter++;
    const transactionID = `TGC-${new Date().getFullYear()}${new Date().getMonth()+1}-${transactionCounter}`;
    
    // Resolve active user info before creating the receipt so staff details are available
    const activeUser = users.find(u => u.username === currentUserName);
    const empId = activeUser ? activeUser.employeeId : 'Unknown';

    const receipt = {
        transactionID,
        customerName: currentOrder.customerName,
        date: new Date().toLocaleDateString("en-CA"),
        items: [...currentOrder.items],
        subtotal: currentOrder.total,
        payment: 0,
        change: 0,
        status: 'pending', // Set status to pending
        staffUsername: currentUserName, // Track who created it
        staffName: currentUserFullName || '',
        employeeId: empId
    };
    purchaseHistory.push(receipt);
    
    // Audit log (use the activeUser/empId resolved above)
    
    auditLog.push({
        timestamp: new Date().toLocaleString(),
        staffUsername: currentUserName,
        staffName: currentUserFullName,
        employeeId: empId,
        action: "Order Created (To Pay)",
        status: "Pending",
        customerName: currentOrder.customerName,
        transactionID: transactionID,
        items: generateAuditItemString(currentOrder.items),
        itemsText: generateAuditItemText(currentOrder.items),
        amount: currentOrder.total
    });

    saveState();
    updateDashboardWidgets();
    showReceiptModal(receipt);
    resetOrderForm();
}

function processPayment() {
    const paymentAmount = parseFloat(document.getElementById("paymentAmount").value);
    if (isNaN(paymentAmount) || paymentAmount < currentOrder.total) {
        showModalMessage("Payment Error", `Insufficient payment. Please enter at least ₱${currentOrder.total.toFixed(2)}.`);
        return;
    }

    const change = paymentAmount - currentOrder.total;

    // Deduct stock
    currentOrder.items.forEach(cartItem => {
        const inventoryItem = inventory.find(invItem => invItem.id === cartItem.id);
        if (inventoryItem) {
            inventoryItem.quantity -= cartItem.quantity;
        }
    });

    transactionCounter++;
    const transactionID = `TGC-${new Date().getFullYear()}${new Date().getMonth()+1}-${transactionCounter}`;
    
    // Resolve active user info before creating the receipt so staff details are available
    const activeUser = users.find(u => u.username === currentUserName);
    const empId = activeUser ? activeUser.employeeId : '';

    const receipt = {
        transactionID,
        customerName: currentOrder.customerName,
        date: new Date().toLocaleDateString("en-CA"),
        items: [...currentOrder.items],
        subtotal: currentOrder.total,
        payment: paymentAmount,
        change: change,
        status: 'completed',
        staffUsername: currentUserName, // Track who created it
        staffName: currentUserFullName || '',
        employeeId: empId
    };
    purchaseHistory.push(receipt);
    
    // Audit Log
    // activeUser/empId already resolved above

    auditLog.push({
        timestamp: new Date().toLocaleString(),
        staffUsername: currentUserName,
        staffName: currentUserFullName,
        employeeId: empId,
        action: "Order Processed (Paid)",
        status: "Completed",
        customerName: currentOrder.customerName,
        transactionID: transactionID,
        items: generateAuditItemString(currentOrder.items),
        itemsText: generateAuditItemText(currentOrder.items),
        amount: currentOrder.total
    });

    saveState();
    updateDashboardWidgets();
    showReceiptModal(receipt);
    resetOrderForm();
}

function resetOrderForm() {
    currentOrder = { customerName: "", items: [], total: 0 };
    currentOrderFilters = { brand: "All", name: "All", type: "All", size: "All", color: "All" };
    document.getElementById("customerName").value = "";
    renderOrderScreen();
}

// --- RECEIPT GENERATION (HTML) ---
function generateReceiptHtml(receipt) {
    const dateStr = new Date(receipt.date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    
    let itemsRows = receipt.items.map(item => {
        const isRefunded = item.refunded === true;
        const itemTotal = (Number(item.quantity || 0) * Number(item.price || 0));
        if (isRefunded) {
            return `
        <tr class="receipt-row">
            <td colspan="4" style="padding-bottom: 0; font-weight:bold; opacity:0.6;">${escapeHtml(item.brand || '')} - ${escapeHtml(item.name || '')} <span style="color: var(--refundColor); font-weight:700; margin-left:8px;">(REFUNDED)</span></td>
        </tr>
        <tr>
            <td style="padding-left: 10px; color: #999; font-size: 0.8rem;">${escapeHtml(item.type || '')}, ${escapeHtml(item.size || '')}, ${escapeHtml(item.color || '')}</td>
            <td class="text-right">${Number(item.quantity) || 0}</td>
            <td class="text-right">x ${Number(item.price || 0).toFixed(2)}</td>
            <td class="text-right">REFUNDED</td>
        </tr>
        `;
        }

        return `
        <tr class="receipt-row">
            <td colspan="4" style="padding-bottom: 0; font-weight:bold;">${escapeHtml(item.brand || '')} - ${escapeHtml(item.name || '')}</td>
        </tr>
        <tr>
            <td style="padding-left: 10px; color: #555; font-size: 0.8rem;">${escapeHtml(item.type || '')}, ${escapeHtml(item.size || '')}, ${escapeHtml(item.color || '')}</td>
            <td class="text-right">${Number(item.quantity) || 0}</td>
            <td class="text-right">x ${Number(item.price || 0).toFixed(2)}</td>
            <td class="text-right">${itemTotal.toFixed(2)}</td>
        </tr>
    `;
    }).join("");

    // Logic for watermark or status indication on receipt
    let watermark = "";
    if (receipt.status === 'pending') {
        watermark = `<div class="receipt-watermark pending">TO PAY</div>`;
    } else if (receipt.status === 'refunded') {
        watermark = `<div class="receipt-watermark refunded">REFUNDED</div>`;
    } else if (receipt.status === 'cancelled') {
        watermark = `<div class="receipt-watermark cancelled">CANCELLED</div>`;
    }

    // If pending, show Amount Due instead of Change
    let totalsSection = "";
    if (receipt.status === 'pending') {
         totalsSection = `
            <div class="receipt-row">
                <span>Subtotal:</span>
                <span>₱${receipt.subtotal.toFixed(2)}</span>
            </div>
            <div class="receipt-row receipt-total-row">
                <span>AMOUNT DUE:</span>
                <span>₱${receipt.subtotal.toFixed(2)}</span>
            </div>
         `;
    } else {
        totalsSection = `
            <div class="receipt-row">
                <span>Subtotal:</span>
                <span>₱${receipt.subtotal.toFixed(2)}</span>
            </div>
            <div class="receipt-row">
                <span>Payment:</span>
                <span>₱${receipt.payment.toFixed(2)}</span>
            </div>
            <div class="receipt-row receipt-total-row">
                <span>CHANGE:</span>
                <span>₱${receipt.change.toFixed(2)}</span>
            </div>
        `;
    }

    return `
        <div class="receipt-box">
            ${watermark}
            <div class="receipt-header-section">
                <h2>THE GLAM CLUB PH</h2>
                <div class="receipt-details">
                    <br>Date: ${escapeHtml(dateStr)}
                        <br>Trans ID: ${escapeHtml(receipt.transactionID)}
                        <br>Customer: ${escapeHtml(receipt.customerName)}
                </div>
            </div>
            
            <table class="receipt-table">
                <thead>
                    <tr>
                        <th width="45%">Item</th>
                        <th width="10%" class="text-right">Qty</th>
                        <th width="20%" class="text-right">Price</th>
                        <th width="25%" class="text-right">Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${itemsRows}
                </tbody>
            </table>

            <div class="receipt-totals">
                ${totalsSection}
            </div>

            <div class="receipt-footer">
                <p>THANK YOU FOR SHOPPING!</p>
                <p>Please come again.</p>
            </div>
        </div>
    `;
}

// --- ADMIN ITEMS LOGIC ---

function checkOther(selectElement, inputId) {
    const input = document.getElementById(inputId);
    if (selectElement.value === 'Other') {
        input.classList.remove('hidden');
        input.focus();
    } else {
        input.classList.add('hidden');
    }
}

function openAddItemModal() {
    adminAction(() => {
        const names = [...new Set(inventory.map(i => i.name))].sort();
        const brands = [...new Set(inventory.map(i => i.brand))].sort();
        const types = [...new Set(inventory.map(i => i.type))].sort();
        const sizes = [...new Set(inventory.map(i => i.size))].sort();
        const colors = [...new Set(inventory.map(i => i.color))].sort();
        const createOptions = (list) => list.map(item => `<option value="${item}">${item}</option>`).join('');

        const modalContent = `
            <div class="modalHeader"><h3>Add New Item</h3><button class="modalCloseBtn" onclick="closeModal()"></button></div>
            <div class="formGrid">
                <div class="formGroup">
                    <label>Name:</label>
                    <select id="addNameSelect" onchange="checkOther(this, 'addNameOtherInput')">
                        <option value="">-- Select or type Other --</option>
                        ${createOptions(names)}
                        <option value="Other">Other...</option>
                    </select>
                    <input type="text" id="addNameOtherInput" placeholder="New Item Name" class="hidden" style="margin-top: 5px;">
                </div>
                <div class="formGroup">
                    <label>Brand:</label>
                    <select id="addBrandSelect" onchange="checkOther(this, 'addBrandOtherInput')">
                        <option value="">-- Select or type Other --</option>
                        ${createOptions(brands)}
                        <option value="Other">Other...</option>
                    </select>
                    <input type="text" id="addBrandOtherInput" placeholder="New Brand" class="hidden" style="margin-top: 5px;">
                </div>
                <div class="formGroup">
                    <label>Type:</label>
                    <select id="addTypeSelect" onchange="checkOther(this, 'addTypeOtherInput')">
                        <option value="">-- Select or type Other --</option>
                        ${createOptions(types)}
                        <option value="Other">Other...</option>
                    </select>
                    <input type="text" id="addTypeOtherInput" placeholder="New Type (e.g. SHOULDER BAG)" class="hidden" style="margin-top: 5px;">
                </div>
                <div class="formGroup">
                    <label>Size:</label>
                    <select id="addSizeSelect" onchange="checkOther(this, 'addSizeOtherInput')">
                        <option value="">-- Select or type Other --</option>
                        ${createOptions(sizes)}
                        <option value="Other">Other...</option>
                    </select>
                    <input type="text" id="addSizeOtherInput" placeholder="New Size (e.g. M, L, Std.)" class="hidden" style="margin-top: 5px;">
                </div>
                <div class="formGroup">
                    <label>Color:</label>
                    <select id="addColorSelect" onchange="checkOther(this, 'addColorOtherInput')">
                        <option value="">-- Select or type Other --</option>
                        ${createOptions(colors)}
                        <option value="Other">Other...</option>
                    </select>
                    <input type="text" id="addColorOtherInput" placeholder="New Color (e.g. BLACK, R5Q)" class="hidden" style="margin-top: 5px;">
                </div>
                <div class="formGroup"><label>Price:</label><input type="number" id="addPrice" step="0.01"></div>
                <div class="formGroup"><label>Quantity:</label><input type="number" id="addQuantity" step="1"></div>
                <div class="formGroup"><label>Reorder Point:</label><input type="number" id="addReorder" step="1"></div>
            </div>
            <div class="modalFooter">
                <button class="btnSecondary" onclick="closeModal()">Cancel</button>
                <button class="btnPrimary" onclick="processAddItem()">Add Item</button>
            </div>
        `;
        showModal(modalContent);
    });
}

function processAddItem() {
    const getValue = (selectId, inputId) => {
        const selectVal = document.getElementById(selectId).value;
        return (selectVal === "Other") ? document.getElementById(inputId).value.trim() : selectVal;
    };

    const name = getValue("addNameSelect", "addNameOtherInput");
    const brand = getValue("addBrandSelect", "addBrandOtherInput");
    const type = getValue("addTypeSelect", "addTypeOtherInput").toUpperCase();
    const size = getValue("addSizeSelect", "addSizeOtherInput") || "Std.";
    const color = getValue("addColorSelect", "addColorOtherInput").toUpperCase() || "N/A";
    
    const price = parseFloat(document.getElementById("addPrice").value);
    const quantity = parseInt(document.getElementById("addQuantity").value);
    const reorderPoint = parseInt(document.getElementById("addReorder").value);

    if (!name || !brand || !type || isNaN(price) || isNaN(quantity) || isNaN(reorderPoint)) {
        showModalMessage("Error", "Please fill all fields with valid data.");
        return;
    }

    const existingItem = inventory.find(item => 
        item.name === name && 
        item.brand === brand && 
        item.type === type && 
        item.size === size && 
        item.color === color
    );

    if (existingItem) {
        existingItem.quantity += quantity;
        existingItem.price = price;
        existingItem.reorderPoint = reorderPoint; 
        saveState();
        showModalMessage("Success", `Item "${name}" (Size: ${size}, Color: ${color}) was updated. New quantity: ${existingItem.quantity}.`);
    } else {
        const newItem = {
            id: inventory.length > 0 ? Math.max(...inventory.map(i => i.id)) + 1 : 1,
            name, brand, type, size, color, price, quantity, reorderPoint
        };
        inventory.push(newItem);
        saveState();
        showModalMessage("Success", `New item "${name}" was added successfully.`);
    }

    if(document.getElementById("inventory").classList.contains("active")) {
        renderInventory();
    }
    updateDashboardWidgets();
}

function openEditItemModal() {
    adminAction(() => {
        const options = inventory
            .sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name))
            .map(item => `<option value="${item.id}">${item.brand} - ${item.name} (${item.type}, Sz: ${item.size}, Color: ${item.color})</option>`)
            .join("");
            
        const modalContent = `
            <div class="modalHeader"><h3>Edit Item</h3><button class="modalCloseBtn" onclick="closeModal()"></button></div>
            <div class="formGroup">
                <label>Select Item to Edit:</label>
                <select id="editItemSelect" onchange="populateEditForm(this.value)">
                    <option value="">-- Select an item --</option>
                    ${options}
                </select>
            </div>
            <div id="editFormContainer"></div>
        `;
        showModal(modalContent);
    });
}

function populateEditForm(itemId) {
    const formContainer = document.getElementById("editFormContainer");
    if (!itemId) {
        formContainer.innerHTML = "";
        return;
    }
    
    const item = inventory.find(i => i.id === Number(itemId));
    if (!item) return;

    formContainer.innerHTML = `
        <div class="formGrid">
            <div class="formGroup"><label>Name:</label><input type="text" id="editName" value="${item.name}"></div>
            <div class="formGroup"><label>Brand:</label><input type="text" id="editBrand" value="${item.brand}"></div>
            <div class="formGroup"><label>Type:</label><input type="text" id="editType" value="${item.type}"></div>
            <div class="formGroup"><label>Size:</label><input type="text" id="editSize" value="${item.size}"></div>
            <div class="formGroup"><label>Color:</label><input type="text" id="editColor" value="${item.color}"></div>
            <div class="formGroup"><label>Price:</label><input type="number" id="editPrice" step="0.01" value="${item.price}"></div>
            <div class="formGroup"><label>Quantity:</label><input type="number" id="editQuantity" step="1" value="${item.quantity}"></div>
            <div class="formGroup"><label>Reorder Point:</label><input type="number" id="editReorder" step="1" value="${item.reorderPoint}"></div>
        </div>
        <div class="modalFooter">
            <button class="btnSecondary" onclick="closeModal()">Cancel</button>
            <button class="btnPrimary" onclick="processEditItem(${item.id})">Save Changes</button>
        </div>
    `;
}

function processEditItem(itemId) {
    const item = inventory.find(i => i.id === itemId);
    if (!item) return;

    item.name = document.getElementById("editName").value.trim();
    item.brand = document.getElementById("editBrand").value.trim();
    item.type = document.getElementById("editType").value.trim().toUpperCase();
    item.size = document.getElementById("editSize").value.trim() || "Std.";
    item.color = document.getElementById("editColor").value.trim().toUpperCase() || "N/A";
    item.price = parseFloat(document.getElementById("editPrice").value);
    item.quantity = parseInt(document.getElementById("editQuantity").value);
    item.reorderPoint = parseInt(document.getElementById("editReorder").value);
    
    if (!item.name || !item.brand || !item.type || isNaN(item.price) || isNaN(item.quantity) || isNaN(item.reorderPoint)) {
        showModalMessage("Error", "Please fill all fields with valid data.");
        return;
    }

    saveState();
    showModalMessage("Success", `Item "${item.name}" was updated successfully.`);
    if(document.getElementById("inventory").classList.contains("active")) {
        renderInventory();
    }
    updateDashboardWidgets();
}

function openRemoveItemModal() {
     adminAction(() => {
        const options = inventory
            .sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name))
            .map(item => `<option value="${item.id}">${item.brand} - ${item.name} (${item.type}, Sz: ${item.size}, Color: ${item.color})</option>`)
            .join("");
            
        const modalContent = `
            <div class="modalHeader"><h3>Remove Item</h3><button class="modalCloseBtn" onclick="closeModal()"></button></div>
            <div class="formGroup">
                <label>Select Item to Remove:</label>
                <select id="removeItemSelect">
                    <option value="">-- Select an item --</option>
                    ${options}
                </select>
            </div>
            <p><strong>Warning:</strong> This action cannot be undone.</p>
            <div class="modalFooter">
                <button class="btnSecondary" onclick="closeModal()">Cancel</button>
                <button class="btnPrimary" style="background-color: #d9534f;" onclick="processRemoveItem()">Confirm Removal</button>
            </div>
        `;
        showModal(modalContent);
    });
}

function processRemoveItem() {
    const itemId = parseInt(document.getElementById("removeItemSelect").value);
    if (!itemId) {
         showModalMessage("Error", "Please select an item to remove.");
         return;
    }
    const itemName = inventory.find(i => i.id === itemId)?.name;
    inventory = inventory.filter(item => item.id !== itemId);
    saveState();
    showModalMessage("Success", `Item "${itemName}" has been removed.`);
    if(document.getElementById("inventory").classList.contains("active")) {
        renderInventory();
    }
    updateDashboardWidgets();
}

// --- UPDATED: LOW STOCK REPORT (TABLE & FULL SCREEN) ---
function showLowStockReport() {
    adminAction(() => {
        const lowStockItems = inventory.filter(item => item.quantity <= item.reorderPoint);
        
        let tableContent = "";
        if (lowStockItems.length === 0) {
            tableContent = "<tr><td colspan='7' class='textCenter'>No items are low on stock.</td></tr>";
        } else {
            lowStockItems.forEach(item => {
                tableContent += `
                    <tr>
                        <td>${escapeHtml(item.name || '')}</td>
                        <td>${escapeHtml(item.brand || '')}</td>
                        <td>${escapeHtml(item.type || '')}</td>
                        <td>${escapeHtml(item.size || '')}</td>
                        <td>${escapeHtml(item.color || '')}</td>
                        <td class="status-low">Low: ${Number(item.quantity || 0)}</td>
                        <td>${Number(item.reorderPoint || 0)}</td>
                    </tr>
                `;
            });
        }

        const modalContent = `
            <div class="modalHeader">
                <h3><i class="fas fa-triangle-exclamation"></i> Low Stock Report</h3>
                <button class="modalCloseBtn" onclick="closeModal()"></button>
            </div>
            <div class="modal-body-scroll">
                <table class="report-table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Brand</th>
                            <th>Type</th>
                            <th>Size</th>
                            <th>Color</th>
                            <th>Current Stock</th>
                            <th>Reorder Point</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableContent}
                    </tbody>
                </table>
            </div>
            <div class="modalFooter">
                <button class="btnSecondary no-print" onclick="exportInventoryCSV()"><i class="fas fa-download"></i> Download CSV</button>
                <button class="btnSecondary no-print" onclick="printModal()"><i class="fas fa-print"></i> Print</button>
                <button class="btnPrimary" onclick="closeModal()">Close</button>
            </div>
        `;
        
        // Use main-panel backdrop logic
        const modalContainer = document.getElementById("modalContent");
        const modalBackdrop = document.getElementById("modalBackdrop");
        // Show fullscreen modal anchored to main panel area (does not change sidebar state)
        modalContainer.classList.add("modalContent-fullscreen");
        modalBackdrop.classList.add("modalBackdrop-mainPanel");
        showModal(modalContent);
    });
}

function showDailySalesReport() {
    adminAction(() => {
         const modalContent = `
            <div class="modalHeader"><h3>Daily Sales Report</h3><button class="modalCloseBtn" onclick="closeModal()"></button></div>
            <div class="formGroup">
                <label>Select Date:</label>
                <input type="date" id="salesReportDate" value="${new Date().toISOString().split('T')[0]}">
            </div>
            <div class="modalFooter">
                <button class="btnSecondary" onclick="closeModal()">Cancel</button>
                <button class="btnPrimary" onclick="generateDailySalesReport()">Generate Report</button>
            </div>
        `;
        showModal(modalContent);
    });
}

// --- UPDATED: DAILY SALES REPORT (TABLE & FULL SCREEN) ---
function generateDailySalesReport() {
    const date = document.getElementById("salesReportDate").value;
    const salesForDate = purchaseHistory.filter(p => p.date === date && p.status === 'completed');

    let totalSales = 0;
    let itemsSold = {};

    salesForDate.forEach(sale => {
        totalSales += sale.subtotal;
        sale.items.forEach(item => {
            // Key includes details to separate different sizes/colors
            const itemKey = `${item.id}`;
            if (itemsSold[itemKey]) {
                itemsSold[itemKey].quantity += item.quantity;
                itemsSold[itemKey].totalValue += item.quantity * item.price;
            } else {
                itemsSold[itemKey] = {
                    name: item.name,
                    brand: item.brand,
                    type: item.type,
                    size: item.size,
                    color: item.color,
                    quantity: item.quantity,
                    totalValue: item.quantity * item.price,
                };
            }
        });
    });
    
    let tableRows = "";
    if (Object.keys(itemsSold).length === 0) {
        tableRows = `<tr><td colspan="6" class="textCenter">No sales recorded for this date.</td></tr>`;
    } else {
        for (const key in itemsSold) {
            const i = itemsSold[key];
            tableRows += `
                <tr>
                    <td>${i.name}</td>
                    <td>${i.brand}</td>
                    <td>${i.type}<br><small>${i.size}, ${i.color}</small></td>
                    <td class="textCenter">${i.quantity}</td>
                    <td class="amount-col">₱${i.totalValue.toFixed(2)}</td>
                </tr>
            `;
        }
    }

    const modalContent = `
        <div class="modalHeader">
            <h3><i class="fas fa-chart-line"></i> Sales Report: ${new Date(date).toLocaleDateString("en-US", {weekday: "long", year: "numeric", month: "long", day: "numeric"})}</h3>
            <button class="modalCloseBtn" onclick="closeModal()"></button>
        </div>
        
        <div class="modal-body-scroll">
             <h4 style="margin-bottom:0.5rem;">Itemized Sales (Completed Transactions Only)</h4>
             <table class="report-table">
                <thead>
                    <tr>
                        <th>Product</th>
                        <th>Brand</th>
                        <th>Details</th>
                        <th>Qty Sold</th>
                        <th>Total Value</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
             </table>
           </div>

        <div class="report-summary-box">
             <p>Total Transactions: ${salesForDate.length}</p>
             <p>Total Revenue: ₱${totalSales.toFixed(2)}</p>
        </div>

        <div class="modalFooter">
            <button class="btnSecondary no-print" onclick="exportDailySalesCSV('${date}')"><i class="fas fa-download"></i> Download</button>
            <button class="btnSecondary no-print" onclick="printModal()"><i class="fas fa-print"></i> Print</button>
            <button class="btnPrimary" onclick="closeModal()">Close</button>
        </div>
    `;

    // Apply full screen and main-panel logic
    const modalContainer = document.getElementById("modalContent");
    const modalBackdrop = document.getElementById("modalBackdrop");
        // Show fullscreen modal anchored to main panel area (does not change sidebar state)
        modalContainer.classList.add("modalContent-fullscreen");
        modalBackdrop.classList.add("modalBackdrop-mainPanel");
        showModal(modalContent);
}

// --- UPDATED: AUDIT TRAIL (GROUPED VIEW) ---
function showAuditTrail() {
    adminAction(() => {
        // Group logs by Transaction ID
        const groupedLogs = {};
        // Helper for logs without transaction IDs (system events?)
        const systemLogs = [];

        auditLog.forEach(log => {
            if (log.transactionID) {
                if (!groupedLogs[log.transactionID]) {
                    groupedLogs[log.transactionID] = [];
                }
                groupedLogs[log.transactionID].push(log);
            } else {
                systemLogs.push(log);
            }
        });

        // Convert to array of "Latest State" objects for display in the table
        // We assume auditLog is chronological, so the last entry is the latest state
        const tableRowsData = Object.values(groupedLogs).map(logs => {
            const latestLog = logs[logs.length - 1];
            return latestLog;
        });

        // Sort by latest timestamp descending
        tableRowsData.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        // Compute overall totals (admin view) using current receipt subtotals
        // (this ensures refunded amounts are already excluded because receipts' subtotal
        //  is adjusted when refunds occur)
        const overallCompletedReceipts = purchaseHistory.filter(p => p.status === 'completed' || p.status === 'refunded');
        const overallRevenue = overallCompletedReceipts.reduce((s, r) => s + (r.subtotal || 0), 0);

        let tableRows = "";
        if (tableRowsData.length === 0 && systemLogs.length === 0) {
            tableRows = `<tr><td colspan="7" class="textCenter">No activity logs found.</td></tr>`;
        } else {
                tableRowsData.forEach(log => {
                const statusClass = log.status ? log.status.toLowerCase() : '';
                const statusDisplay = log.status 
                    ? `<span class="audit-status ${statusClass}">${log.status}</span>` 
                    : '<span style="color:#888">-</span>';

                    // Use the live receipt (if present) to display the current items and subtotal
                    const receipt = purchaseHistory.find(p => p.transactionID === log.transactionID);
                    let itemsHtml = '';
                    if (receipt && Array.isArray(receipt.items)) {
                        // Annotate refunded items
                        itemsHtml = receipt.items.map(i => {
                            const refundedMark = i.refunded ? ' <span style="color:var(--refundColor); font-weight:600;">(REFUNDED)</span>' : '';
                            return `<li><b>${i.quantity}x</b> ${escapeHtml(i.brand||'')} - ${escapeHtml(i.name||'')} <span class="audit-item-details">(${escapeHtml(i.type||'')}, ${escapeHtml(i.size||'')}, ${escapeHtml(i.color||'')})</span>${refundedMark}</li>`;
                        }).join('');
                        itemsHtml = `<ul class="audit-item-list">${itemsHtml}</ul>`;
                    } else if (Array.isArray(log.items)) {
                        itemsHtml = generateAuditItemString(log.items);
                    } else if (log.itemsText) {
                        itemsHtml = textToList(log.itemsText);
                    } else if (log.items) {
                        const stripped = stripTags(log.items);
                        itemsHtml = textToList(stripped);
                    } else {
                        itemsHtml = '<span style="color:#777">-</span>';
                    }

                    const displayAmount = receipt ? Number(receipt.subtotal || 0) : (log.amount ? Number(log.amount) : 0);

                    tableRows += `
                            <tr onclick="showTransactionHistory('${encodeURIComponent(log.transactionID||'')}')" style="cursor: pointer;" title="Click to view full history">
                                <td>${escapeHtml(log.timestamp)}</td>
                                <td>${escapeHtml(log.staffName || '')}<br><small style="color:#777">${escapeHtml(log.employeeId || '')}</small></td>
                                <td>${escapeHtml(log.customerName || '-')}</td>
                                <td>${escapeHtml(log.transactionID || '-')}</td>
                                <td class="textCenter">${statusDisplay}</td>
                                <td class="audit-items-col">${itemsHtml}</td>
                                <td class="amount-col">₱${displayAmount.toFixed(2)}</td>
                            </tr>
                        `;
            });
        }

        const modalContent = `
            <div class="modalHeader">
                <h3><i class="fas fa-clipboard-list"></i> Audit Trail</h3>
                <button class="modalCloseBtn" onclick="closeModal()"></button>
            </div>
            <div class="modal-body-scroll">
                <p style="margin-bottom: 10px; font-size: 0.9rem; color: #666;">
                    <i class="fas fa-info-circle"></i> Click on a row to view the detailed history for that transaction.
                </p>
                <p style="margin-bottom: 10px; font-size: 1rem; color: #333; font-weight:700;">
                    Overall Completed Revenue: ₱${overallRevenue.toFixed(2)}
                </p>
                <table class="report-table">
                    <thead>
                        <tr>
                            <th>Latest Update</th>
                            <th>Staff Details</th>
                            <th>Customer</th>
                            <th>Transaction ID</th>
                            <th>Current Status</th>
                            <th>Items</th>
                            <th>Amount</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows}
                    </tbody>
                </table>
            </div>
            <div class="modalFooter">
                <button class="btnSecondary no-print" onclick="exportAuditTrail()"><i class="fas fa-download"></i> Download</button>
                <button class="btnSecondary no-print" onclick="printModal()"><i class="fas fa-print"></i> Print</button>
                <button class="btnPrimary" onclick="closeModal()">Close</button>
            </div>
        `;
        
        // Apply full screen and main-panel logic
        const modalContainer = document.getElementById("modalContent");
        const modalBackdrop = document.getElementById("modalBackdrop");
        // Show fullscreen modal anchored to main panel area (does not change sidebar state)
        modalContainer.classList.add("modalContent-fullscreen");
        modalBackdrop.classList.add("modalBackdrop-mainPanel");
        showModal(modalContent);
    });
}

function showTransactionHistory(transactionID) {
    try { transactionID = decodeURIComponent(transactionID); } catch(e) { /* ignore */ }
    // Find all logs for this transaction
    const logs = auditLog.filter(l => l.transactionID === transactionID);
    
    if (!logs.length) return;

    let timelineHTML = '<div class="history-timeline">';
    logs.forEach(log => {
        const statusClass = log.status ? log.status.toLowerCase() : '';
        timelineHTML += `
            <div class="history-item">
                <div class="history-date">${log.timestamp}</div>
                <div class="history-action">
                    ${log.action} 
                    ${log.status ? `<span class="audit-status ${statusClass}" style="font-size:0.7rem; vertical-align: middle; margin-left: 8px;">${log.status}</span>` : ''}
                </div>
                <div class="history-staff">Processed by: <strong>${log.staffName}</strong> (${log.employeeId})</div>
                ${log.amount ? `<div class="history-details">Amount: ₱${log.amount.toFixed(2)}</div>` : ''}
            </div>
        `;
    });
    timelineHTML += '</div>';

    // Determine appropriate back action depending on current user role (admin vs staff)
    const backBtn = (currentUserRole === 'admin')
        ? `<button class="btnSecondary" onclick="showAuditTrail()">Back to List</button>`
        : `<button class="btnSecondary" onclick="showStaffAuditTrail()">Back to List</button>`;

    const modalContent = `
        <div class="modalHeader">
            <h3>History: ${transactionID}</h3>
            <button class="modalCloseBtn" onclick="closeModal()"></button>
        </div>
        <div class="modal-body-scroll">
            <h4 style="margin-bottom: 1rem;">Transaction Timeline</h4>
            ${timelineHTML}
        </div>
        <div class="modalFooter">
            ${backBtn}
            <button class="btnPrimary" onclick="closeModal()">Close</button>
        </div>
    `;
    
    // reuse the showModal function.
    showModal(modalContent);
}

// --- HISTORY LOGIC FOR FILTERS & ACTIONS ---

function setHistoryFilter(filter, btnElement) {
    currentHistoryFilter = filter;
    
    // Update UI active state
    document.querySelectorAll('.historyFilterBar .filterTag').forEach(btn => btn.classList.remove('active'));
    if (btnElement) btnElement.classList.add('active');
    
    renderPurchaseHistory();
}

function renderPurchaseHistory() {
    const searchTerm = document.getElementById("historySearchInput").value.trim().toLowerCase();
    const historyList = document.getElementById("historyList");
    historyList.innerHTML = "";

    // Filter based on both search term AND category filter
    const results = purchaseHistory.filter(p => {
        // 1. Role-based Visibility Filter
        // If user is staff, they only see their own transactions.
        // Admin sees everything.
        if (currentUserRole === 'staff' && p.staffUsername !== currentUserName) {
            return false;
        }

        // 2. Text Search
        const matchesSearch = searchTerm === "" || 
                              p.customerName.toLowerCase().includes(searchTerm) || 
                              p.transactionID.toLowerCase().includes(searchTerm);
        
        // 3. Status Filter
        let matchesFilter = true;
        if (currentHistoryFilter === 'pending') {
            matchesFilter = p.status === 'pending';
        } else if (currentHistoryFilter === 'completed') {
            matchesFilter = p.status === 'completed';
        } else if (currentHistoryFilter === 'refunded') {
            matchesFilter = p.status === 'refunded';
        } else if (currentHistoryFilter === 'cancelled') {
            matchesFilter = p.status === 'cancelled';
        }
        
        return matchesSearch && matchesFilter;
    });
    
    if (results.length === 0) {
        historyList.innerHTML = `<p class="emptyMessage">No purchase history found.</p>`;
        return;
    }
    
    results.reverse().forEach(receipt => {
        const card = document.createElement("div");
        card.className = "receiptCard";
        if (receipt.status === 'cancelled') card.classList.add('is-cancelled');
        
        // Click to view receipt
        card.onclick = () => showReceiptModalById(receipt.transactionID);

        // Logic for Action Buttons based on Status
        let actionHTML = '';
        let statusBadge = '';

        if (receipt.status === 'pending') {
            statusBadge = '<span class="statusBadge pending">To Pay</span>';
            actionHTML = `
                <button class="btnPay" onclick="openPayPendingModal('${receipt.transactionID}', event)">Pay Now</button>
                <button class="btnCancel" onclick="confirmCancelReceipt('${receipt.transactionID}', event)">Cancel Order</button>
            `;
        } else if (receipt.status === 'completed') {
            statusBadge = '<span class="statusBadge completed">Completed</span>';
            actionHTML = `
                <button class="btnRefund" onclick="confirmRefundReceipt('${receipt.transactionID}', event)">Refund</button>
            `;
        } else if (receipt.status === 'refunded') {
            statusBadge = '<span class="statusBadge refunded">Refunded</span>';
        } else if (receipt.status === 'cancelled') {
            statusBadge = '<span class="statusBadge cancelled">Cancelled</span>';
        }

        card.innerHTML = `
            <div class="receiptCardInfo">
                <strong>Customer: ${receipt.customerName}</strong><br>
                ID: ${receipt.transactionID} | Date: ${receipt.date}<br>
                <span style="font-weight:bold; color: #555;">Total: ₱${receipt.subtotal.toFixed(2)}</span>
            </div>
            <div class="receiptCardActions">
                ${statusBadge}
                ${actionHTML}
            </div>
        `;
        historyList.appendChild(card);
    });
}

// Staff-facing audit: shows only processed (completed) transactions by the current staff member
function showStaffAuditTrail() {
    // Ensure the user is logged in
    if (!currentUserName) {
        showModalMessage('Not Logged In', 'Please log in to view your transactions.');
        return;
    }
    // Use the same layout as the admin Audit Trail but scoped to this staff member
    const staffReceipts = purchaseHistory.filter(p => p.staffUsername === currentUserName).slice();
    // sort by timestamp/date descending
    staffReceipts.sort((a,b) => new Date(b.date) - new Date(a.date));

    // Compute total revenue for this staff (use current subtotals so refunds are excluded)
    const totalRevenue = staffReceipts.reduce((s, r) => s + (r.subtotal || 0), 0);

    let tableRows = '';
    if (staffReceipts.length === 0) {
        tableRows = `<tr><td colspan="7" class="textCenter">No transactions found for your account.</td></tr>`;
    } else {
        staffReceipts.forEach(r => {
            const statusClass = r.status ? r.status.toLowerCase() : '';
            const statusDisplay = r.status ? `<span class="audit-status ${statusClass}">${r.status}</span>` : '<span style="color:#888">-</span>';

            // Build items HTML and annotate refunded items
            let itemsHtml = '';
            if (Array.isArray(r.items)) {
                itemsHtml = r.items.map(i => {
                    const refundedMark = i.refunded ? ' <span style="color:var(--refundColor); font-weight:600;">(REFUNDED)</span>' : '';
                    return `<li><b>${i.quantity}x</b> ${escapeHtml(i.brand||'')} - ${escapeHtml(i.name||'')} <span class="audit-item-details">(${escapeHtml(i.type||'')}, ${escapeHtml(i.size||'')}, ${escapeHtml(i.color||'')})</span>${refundedMark}</li>`;
                }).join('');
                itemsHtml = `<ul class="audit-item-list">${itemsHtml}</ul>`;
            } else if (r.itemsText) {
                itemsHtml = textToList(r.itemsText);
            } else if (r.items) {
                itemsHtml = textToList(stripTags(r.items));
            } else {
                itemsHtml = '<span style="color:#777">-</span>';
            }

            tableRows += `
                <tr onclick="showTransactionHistory('${encodeURIComponent(r.transactionID||'')}')" style="cursor:pointer;" title="Click to view full history">
                    <td>${escapeHtml(r.date||'')}</td>
                    <td>${escapeHtml(currentUserFullName || currentUserName)}<br><small style="color:#777">${escapeHtml((users.find(u=>u.username===currentUserName)||{}).employeeId||'')}</small></td>
                    <td>${escapeHtml(r.customerName || '-')}</td>
                    <td>${escapeHtml(r.transactionID || '-')}</td>
                    <td class="textCenter">${statusDisplay}</td>
                    <td class="audit-items-col">${itemsHtml}</td>
                    <td class="amount-col">₱${Number(r.subtotal || 0).toFixed(2)}</td>
                </tr>
            `;
        });
    }

    const modalContent = `
        <div class="modalHeader">
            <h3><i class="fas fa-clipboard-list"></i> My Transactions (Audit View)</h3>
            <button class="modalCloseBtn" onclick="closeModal()"></button>
        </div>
        <div class="modal-body-scroll">
            <p style="margin-bottom: 10px; font-size: 1rem; color: #333; font-weight:700;">Processed by: ${escapeHtml(currentUserFullName || currentUserName)} — Total Revenue: ₱${totalRevenue.toFixed(2)}</p>
            <table class="report-table">
                <thead>
                    <tr>
                        <th>Latest Update</th>
                        <th>Staff Details</th>
                        <th>Customer</th>
                        <th>Transaction ID</th>
                        <th>Current Status</th>
                        <th>Items</th>
                        <th>Amount</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
            </table>
        </div>
        <div class="modalFooter">
            <button class="btnSecondary no-print" onclick="downloadStaffTransactions('${currentUserName}')"><i class="fas fa-download"></i> Download</button>
            <button class="btnSecondary no-print" onclick="printStaffTransactions('${currentUserName}')"><i class="fas fa-print"></i> Print</button>
            <button class="btnPrimary" onclick="closeModal()">Close</button>
        </div>
    `;

    const modalContainer = document.getElementById("modalContent");
    const modalBackdrop = document.getElementById("modalBackdrop");
    modalContainer.classList.add("modalContent-fullscreen");
    modalBackdrop.classList.add("modalBackdrop-mainPanel");
    showModal(modalContent);
}

// --- PAY PENDING LOGIC ---
function openPayPendingModal(transactionID, event) {
    event.stopPropagation();
    const receipt = purchaseHistory.find(p => p.transactionID === transactionID);
    if(!receipt) return;

    const modalContent = `
        <div class="modalHeader"><h3>Complete Payment</h3><button class="modalCloseBtn" onclick="closeModal()"></button></div>
        <p>Customer: <strong>${receipt.customerName}</strong></p>
        <p>Total Amount Due: <strong>₱${receipt.subtotal.toFixed(2)}</strong></p>
        <div class="formGroup">
            <label for="pendingPaymentAmount">Enter Payment Amount:</label>
            <input type="number" id="pendingPaymentAmount" step="0.01" placeholder="0.00">
        </div>
        <div class="modalFooter">
            <button class="btnSecondary" onclick="closeModal()">Cancel</button>
            <button class="btnPrimary" onclick="processPendingPayment('${transactionID}')">Confirm Payment</button>
        </div>
    `;
    showModal(modalContent);
    document.getElementById("pendingPaymentAmount").focus();
}

function processPendingPayment(transactionID) {
    const receipt = purchaseHistory.find(p => p.transactionID === transactionID);
    if(!receipt) return;

    const paymentAmount = parseFloat(document.getElementById("pendingPaymentAmount").value);
    if (isNaN(paymentAmount) || paymentAmount < receipt.subtotal) {
        showModalMessage("Payment Error", `Insufficient payment. Please enter at least ₱${receipt.subtotal.toFixed(2)}.`);
        return;
    }

    const change = paymentAmount - receipt.subtotal;
    
    // Update Receipt
    receipt.payment = paymentAmount;
    receipt.change = change;
    receipt.status = 'completed';

    // Audit Log
    const activeUser = users.find(u => u.username === currentUserName);
    const empId = activeUser ? activeUser.employeeId : "Unknown";
    auditLog.push({
        timestamp: new Date().toLocaleString(),
        staffUsername: currentUserName,
        staffName: currentUserFullName,
        employeeId: empId,
        action: "Pending Order Paid",
        status: "Completed",
        customerName: receipt.customerName,
        transactionID: transactionID,
        items: generateAuditItemString(receipt.items),
        itemsText: generateAuditItemText(receipt.items),
        amount: receipt.subtotal
    });

    saveState();
    closeModal();
    showModalMessage("Success", "Payment recorded and receipt updated to Completed.");
    
    updateDashboardWidgets(); // Update revenue
    renderPurchaseHistory();
}

// --- CANCEL LOGIC (For Pending Orders) ---
function confirmCancelReceipt(transactionID, event) {
    event.stopPropagation();
    const modalContent = `
        <div class="modalHeader"><h3>Confirm Cancellation</h3><button class="modalCloseBtn" onclick="closeModal()"></button></div>
        <p>Are you sure you want to cancel this pending order <strong>${transactionID}</strong>?</p>
        <p>This action will return all items to the inventory and cannot be undone.</p>
        <div class="modalFooter">
            <button class="btnSecondary" onclick="closeModal()">Back</button>
            <button class="btnPrimary" style="background-color: #d9534f;" onclick="processCancellation('${transactionID}')">Confirm Cancel</button>
        </div>
    `;
    showModal(modalContent);
}

function processCancellation(transactionID) {
    const receipt = purchaseHistory.find(p => p.transactionID === transactionID);
    if (!receipt) return;

    // Restore Stock
    receipt.items.forEach(item => {
        const inventoryItem = inventory.find(invItem => invItem.id === item.id);
        if (inventoryItem) {
            inventoryItem.quantity += item.quantity;
        }
    });

    receipt.status = 'cancelled';
    
    // Audit
    const activeUser = users.find(u => u.username === currentUserName);
    const empId = activeUser ? activeUser.employeeId : "Unknown";

    auditLog.push({
        timestamp: new Date().toLocaleString(),
        staffUsername: currentUserName,
        staffName: currentUserFullName,
        employeeId: empId,
        action: "Pending Order Cancelled",
        status: "Cancelled", 
        customerName: receipt.customerName,
        transactionID: transactionID,
        items: generateAuditItemString(receipt.items),
        itemsText: generateAuditItemText(receipt.items),
        amount: 0
    });

    saveState();
    closeModal();
    showModalMessage("Success", `Order ${transactionID} has been cancelled. Stock was restored.`);
    
    updateDashboardWidgets();
    renderPurchaseHistory();
    if(document.getElementById("inventory").classList.contains("active")) renderInventory();
}

// --- REFUND LOGIC (For Completed Orders) ---
function confirmRefundReceipt(transactionID, event) {
    event.stopPropagation();
    const receipt = purchaseHistory.find(p => p.transactionID === transactionID);
    if (!receipt) return;

    // Build list of items with checkboxes so user can choose specific items to refund
    const itemsListHtml = receipt.items.map((item, idx) => {
        const already = item.refunded === true;
        return `
            <div style="display:flex; align-items:center; gap:10px; padding:6px 0;">
                <input type="checkbox" id="refund_chk_${transactionID}_${idx}" ${already ? 'checked disabled' : ''} />
                <label for="refund_chk_${transactionID}_${idx}" style="flex:1; ${already ? 'color:#999;' : ''}">
                    <strong>${escapeHtml(item.brand || '')} - ${escapeHtml(item.name || '')}</strong>
                    <div style="font-size:0.85rem; color:#666;">${escapeHtml(item.type || '')}, ${escapeHtml(item.size || '')}, ${escapeHtml(item.color || '')} — Qty: ${item.quantity} @ ₱${Number(item.price).toFixed(2)}</div>
                </label>
            </div>
        `;
    }).join("");

    const modalContent = `
        <div class="modalHeader"><h3>Select Items to Refund</h3><button class="modalCloseBtn" onclick="closeModal()"></button></div>
        <p>Choose which items from <strong>${transactionID}</strong> you want to refund. Already-refunded items are disabled.</p>
        <div style="max-height: 40vh; overflow:auto; padding:8px 0;">${itemsListHtml}</div>
        <div style="margin-top:0.75rem; display:flex; gap:8px; align-items:center;">
            <input type="checkbox" id="refund_select_all_${transactionID}" /> <label for="refund_select_all_${transactionID}">Select all</label>
        </div>
        <div class="modalFooter">
            <button class="btnSecondary" onclick="closeModal()">Back</button>
            <button class="btnPrimary" style="background-color: #8e44ad;" onclick="processRefund('${transactionID}')">Confirm Refund</button>
        </div>
    `;
    showModal(modalContent);

    // wire up select-all behavior after modal is shown
    setTimeout(() => {
        const selAll = document.getElementById(`refund_select_all_${transactionID}`);
        if (!selAll) return;

        // find all refund checkboxes for this transaction
        const findChecks = () => Array.from(document.querySelectorAll('input[type=checkbox]'))
            .filter(i => i.id && i.id.startsWith(`refund_chk_${transactionID}_`));

        // Initialize select-all state based on current checkboxes (ignore disabled)
        const init = () => {
            const checks = findChecks().filter(cb => !cb.disabled);
            if (checks.length === 0) {
                selAll.checked = false;
                selAll.indeterminate = false;
                return;
            }
            const allChecked = checks.every(cb => cb.checked);
            const someChecked = checks.some(cb => cb.checked);
            selAll.checked = allChecked;
            selAll.indeterminate = !allChecked && someChecked;
        };

        // When select-all changes, toggle all non-disabled checkboxes accordingly
        selAll.addEventListener('change', (e) => {
            const checks = findChecks();
            checks.forEach(cb => { if (!cb.disabled) cb.checked = e.target.checked; });
            selAll.indeterminate = false;
        });

        // Wire each checkbox to update the select-all/indeterminate state
        const wireChecks = () => {
            const checks = findChecks();
            checks.forEach(cb => {
                // remove previous listener marker (avoid dupes)
                if (!cb._refundListener) {
                    cb.addEventListener('change', init);
                    cb._refundListener = true;
                }
            });
        };

        wireChecks();
        init();
    }, 50);
}

function processRefund(transactionID) {
    const receipt = purchaseHistory.find(p => p.transactionID === transactionID);
    if (!receipt) return;

    // Determine which checkboxes were selected (if modal used)
    const selectedItemIndexes = [];
    receipt.items.forEach((item, idx) => {
        const el = document.getElementById(`refund_chk_${transactionID}_${idx}`);
        if (el && el.checked && !el.disabled) selectedItemIndexes.push(idx);
    });

    // If no selections found (e.g., called from other flows), default to refund all non-refunded items
    if (selectedItemIndexes.length === 0) {
        receipt.items.forEach((item, idx) => { if (!item.refunded) selectedItemIndexes.push(idx); });
    }

    if (selectedItemIndexes.length === 0) {
        showModalMessage("Refund Error", "No refundable items selected.");
        return;
    }

    // Process refund for selected items
    let refundedAmount = 0;
    const refundedItems = [];

    selectedItemIndexes.forEach(idx => {
        const item = receipt.items[idx];
        if (!item || item.refunded) return;

        // Restore stock for this item
        const inventoryItem = inventory.find(invItem => invItem.id === item.id);
        if (inventoryItem) {
            inventoryItem.quantity += item.quantity;
        }

        // Mark this item as refunded
        item.refunded = true;

        const amount = Number(item.quantity || 0) * Number(item.price || 0);
        refundedAmount += amount;
        refundedItems.push(Object.assign({}, item));
    });

    // Adjust receipt subtotal/payment/change accordingly
    receipt.subtotal = Math.max(0, Number(receipt.subtotal || 0) - refundedAmount);
    // If payment and change exist, we will reduce payment by refunded amount and adjust change
    if (typeof receipt.payment === 'number') {
        // reduce payment by refunded amount (customer gets refunded), keep change as-is minimal approach
        receipt.payment = Math.max(0, receipt.payment - refundedAmount);
        receipt.change = Math.max(0, Number(receipt.change || 0));
    }

    // If all items refunded, mark order refunded; if some refunded, keep status as completed but note partial
    const allRefunded = receipt.items.every(i => i.refunded === true);
    receipt.status = allRefunded ? 'refunded' : (receipt.status === 'pending' ? 'pending' : 'completed');

    // Audit only refunded items
    const activeUser = users.find(u => u.username === currentUserName);
    const empId = activeUser ? activeUser.employeeId : "Unknown";

    auditLog.push({
        timestamp: new Date().toLocaleString(),
        staffUsername: currentUserName,
        staffName: currentUserFullName,
        employeeId: empId,
        action: allRefunded ? "Order Refunded" : "Partial Refund",
        status: allRefunded ? "Refunded" : "Completed",
        customerName: receipt.customerName,
        transactionID: transactionID,
        items: generateAuditItemString(refundedItems),
        itemsText: generateAuditItemText(refundedItems),
        amount: -refundedAmount
    });

    saveState();
    closeModal();
    showModalMessage("Success", `Refund processed for ${refundedItems.length} item(s). Amount refunded: ₱${refundedAmount.toFixed(2)}.`);
    
    updateDashboardWidgets();
    renderPurchaseHistory();
    if(document.getElementById("inventory").classList.contains("active")) renderInventory();
}

const modalBackdrop = document.getElementById("modalBackdrop");
const modalContentDiv = document.getElementById("modalContent");

function showModal(content) {
    modalContentDiv.innerHTML = content;
    modalBackdrop.classList.remove("hidden");
    // Ensure any password toggle icons appear for dynamically injected content
    try { ensureToggleIcons(); } catch (e) { /* ignore */ }
}

function closeModal() {
    modalBackdrop.classList.add("hidden");
    modalContentDiv.innerHTML = "";
    // Reset modifiers
    modalContentDiv.classList.remove("modalContent-fullscreen");
    modalContentDiv.classList.remove("modalContent-wide");
    modalBackdrop.classList.remove("modalBackdrop-mainPanel");
}

function showModalMessage(title, message) {
    const modalContent = `
        <div class="modalHeader"><h3>${escapeHtml(title)}</h3><button class="modalCloseBtn" onclick="closeModal()"></button></div>
        <p>${escapeHtml(message)}</p>
        <div class="modalFooter"><button class="btnPrimary" onclick="closeModal()">OK</button></div>
    `;
    showModal(modalContent);
}

function showReceiptModalById(transactionID) {
    const receipt = purchaseHistory.find(p => p.transactionID === transactionID);
    if (receipt) {
        showReceiptModal(receipt);
    } else {
        showModalMessage("Error", "Could not find receipt details.");
    }
}

function showReceiptModal(receipt) {
    // Generate HTML instead of text
    const receiptHtml = generateReceiptHtml(receipt);
    
    let statusHeader = '<h3>Receipt</h3>';
    let statusClass = '';

    if (receipt.status === 'cancelled') {
        statusHeader = '<h3 class="cancelled-stamp">CANCELLED</h3>';
        statusClass = 'cancelled-receipt';
    } else if (receipt.status === 'pending') {
        statusHeader = '<h3 class="pending-stamp">UNPAID</h3>';
    } else if (receipt.status === 'refunded') {
        statusHeader = '<h3 class="refunded-stamp">REFUNDED</h3>';
        statusClass = 'cancelled-receipt'; // reuse opacity style
    }

    const modalContent = `
        <div class="modalHeader">${statusHeader}<button class="modalCloseBtn no-print" onclick="closeModal()"></button></div>
        <div class="receiptModal ${statusClass}">${receiptHtml}</div>
        <div class="modalFooter">
            <button class="btnSecondary no-print" onclick="printReceipt('${receipt.transactionID}')"><i class="fas fa-print"></i> Print</button>
            <button class="btnSecondary no-print" onclick="downloadReceiptPDF('${receipt.transactionID}')"><i class="fas fa-download"></i> Download</button>
            <button class="btnPrimary no-print" onclick="closeModal()">Close</button>
        </div>
    `;
    showModal(modalContent);
}

modalBackdrop.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) {
        closeModal();
    }
});

// Print the currently visible receipt modal (simple wrapper)
// Print the receipt by generating the same PDF as the download and printing it.
async function printReceipt(transactionID) {
    try {
        // If the receipt modal is visible, prefer printing the modal directly
        const visibleReceipt = modalContentDiv.querySelector('.receipt-box');
        if (visibleReceipt) {
            // Allow print styles to apply and print only modal content
            printModal();
            return;
        }

        // generate PDF and open it for printing
        const blob = await generateReceiptPDFBlob(transactionID);
        if (!blob) {
            showToast('No receipt available to print.', 'error');
            return;
        }

        const url = URL.createObjectURL(blob);
        const printWindow = window.open(url);
        if (printWindow) {
            printWindow.onload = () => {
                try {
                    printWindow.focus();
                    printWindow.print();
                } catch (e) {
                    console.warn('printWindow.print failed', e);
                }
                setTimeout(() => {
                    try { printWindow.close(); } catch (e) {}
                    URL.revokeObjectURL(url);
                }, 500);
            };
        } else {
            // If popup blocked, fall back to opening in same tab
            window.location.href = url;
        }
    } catch (e) {
        console.error('printReceipt error', e);
        showToast('Failed to print receipt.', 'error');
    }
}

// Generate a PDF from the visible receipt using html2canvas + jsPDF
async function downloadReceiptPDF(transactionID) {
    try {
        const blob = await generateReceiptPDFBlob(transactionID);
        if (!blob) {
            showToast('No receipt visible to download.', 'error');
            return;
        }
        const filename = `receipt_${transactionID || Date.now()}.pdf`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('Receipt downloaded as PDF.', 'success');
    } catch (e) {
        console.error('downloadReceiptPDF error', e);
        showToast('Failed to generate PDF.', 'error');
        throw e;
    }
}

// Helper: generate a PDF Blob for the visible receipt or by transaction ID
async function generateReceiptPDFBlob(transactionID) {
    const receiptEl = (transactionID ? null : modalContentDiv.querySelector('.receipt-box')) || modalContentDiv.querySelector('.receipt-box');
    let elementToRender = receiptEl;
    if (!elementToRender && transactionID) {
        const receipt = purchaseHistory.find(p => p.transactionID === transactionID);
        if (!receipt) return null;
        const tempWrap = document.createElement('div');
        tempWrap.style.position = 'fixed';
        tempWrap.style.left = '-9999px';
        tempWrap.style.top = '0';
        tempWrap.innerHTML = generateReceiptHtml(receipt);
        document.body.appendChild(tempWrap);
        elementToRender = tempWrap;
    }

    if (!elementToRender) return null;

    if (typeof html2canvas === 'undefined' || typeof window.jspdf === 'undefined') {
        throw new Error('Required libraries (html2canvas or jsPDF) not loaded');
    }

    try {
        const canvas = await html2canvas(elementToRender, { scale: 2, useCORS: true });
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('p', 'mm', 'a4');
        const pageWidthMm = pdf.internal.pageSize.getWidth();
        const pageHeightMm = pdf.internal.pageSize.getHeight();
        const marginMm = 10;
        const contentWidthMm = pageWidthMm - marginMm * 2;

        const canvasWidthPx = canvas.width;
        const canvasHeightPx = canvas.height;
        const imgData = canvas.toDataURL('image/png');

        let imgWidthMm = contentWidthMm;
        let imgHeightMm = imgWidthMm * (canvasHeightPx / canvasWidthPx);
        const contentHeightMm = pageHeightMm - marginMm * 2;
        if (imgHeightMm > contentHeightMm) {
            const scale = contentHeightMm / imgHeightMm;
            imgWidthMm = imgWidthMm * scale;
            imgHeightMm = imgHeightMm * scale;
        }

        const x = marginMm + (contentWidthMm - imgWidthMm) / 2;
        const y = marginMm + (contentHeightMm - imgHeightMm) / 2;

        pdf.addImage(imgData, 'PNG', x, y, imgWidthMm, imgHeightMm);
        if (elementToRender && elementToRender.parentNode && elementToRender.parentNode.style && elementToRender.parentNode.style.left === '-9999px') {
            document.body.removeChild(elementToRender.parentNode);
        }

        const arrayBuf = pdf.output('arraybuffer');
        return new Blob([arrayBuf], { type: 'application/pdf' });
    } catch (e) {
        console.error('generateReceiptPDFBlob error', e);
        throw e;
    }
}

function exportDailySalesCSV(date) {
    // Build aggregated itemized sales (same as on-site report) + transactions + summary
    const salesForDate = purchaseHistory.filter(p => p.date === date && p.status === 'completed');

    // Aggregate items across transactions
    const itemsSold = {};
    let totalRevenue = 0;
    salesForDate.forEach(sale => {
        totalRevenue += Number(sale.subtotal || 0);
        (sale.items || []).forEach(item => {
            const key = `${item.id}`;
            if (itemsSold[key]) {
                itemsSold[key].quantity += item.quantity;
                itemsSold[key].totalValue += item.quantity * item.price;
            } else {
                itemsSold[key] = {
                    name: item.name,
                    brand: item.brand,
                    type: item.type,
                    size: item.size,
                    color: item.color,
                    quantity: item.quantity,
                    totalValue: item.quantity * item.price
                };
            }
        });
    });

    // Prepare sheets: Itemized, Transactions (with bullet items), Summary
    const itemHeaders = ['Product','Brand','Details','Qty Sold','Total Value'];
    const itemAoA = [itemHeaders];
    Object.values(itemsSold).forEach(i => {
        itemAoA.push([
            i.name || '',
            i.brand || '',
            `${i.type || ''} (${i.size || ''}, ${i.color || ''})`,
            Number(i.quantity || 0),
            Number(i.totalValue || 0)
        ]);
    });

    // Transactions sheet
    const transHeaders = ['TransactionID','Date','Customer','StaffUsername','StaffName','EmployeeID','Status','Subtotal','Payment','Change','Items'];
    const transAoA = [transHeaders];
    salesForDate.forEach(s => {
        const itemsBullet = generateAuditItemText(s.items || []); // already newline-bullet formatted
        transAoA.push([
            s.transactionID || '',
            s.date || '',
            s.customerName || '',
            s.staffUsername || '',
            s.staffName || '',
            s.employeeId || '',
            s.status || '',
            Number(s.subtotal || 0),
            Number(s.payment || 0),
            Number(s.change || 0),
            itemsBullet
        ]);
    });

    // Summary sheet
    const summaryAoA = [['Metric','Value'], ['Total Transactions', salesForDate.length], ['Total Revenue', totalRevenue.toFixed(2)]];

    const filename = 'daily-sales-' + date + '.xlsx';

    if (typeof XLSX !== 'undefined') {
        const wb = XLSX.utils.book_new();

        const wsItems = XLSX.utils.aoa_to_sheet(itemAoA);
        // compute reasonable column widths
        wsItems['!cols'] = itemAoA[0].map((h, i) => ({ wch: Math.max(8, Math.min(60, Math.ceil(Math.max(...itemAoA.map(r => String(r[i]||'').length)) * 1.1))) }));
        XLSX.utils.book_append_sheet(wb, wsItems, 'Itemized Sales');

        const wsTrans = XLSX.utils.aoa_to_sheet(transAoA);
        wsTrans['!cols'] = transAoA[0].map((h, i) => ({ wch: Math.max(10, Math.min(100, Math.ceil(Math.max(...transAoA.map(r => String(r[i]||'').length)) * 1.1))) }));
        XLSX.utils.book_append_sheet(wb, wsTrans, 'Transactions');

        const wsSummary = XLSX.utils.aoa_to_sheet(summaryAoA);
            // Auto-fit summary columns to content lengths
            try {
                const maxLens = [0,0];
                summaryAoA.forEach(row => {
                    for (let c = 0; c < 2; c++) {
                        const val = row[c] !== undefined && row[c] !== null ? String(row[c]) : '';
                        maxLens[c] = Math.max(maxLens[c], Math.min(120, Math.ceil(val.length)));
                    }
                });
                wsSummary['!cols'] = maxLens.map(l => ({ wch: Math.max(8, Math.min(80, Math.ceil(l * 1.1))) }));
            } catch (e) {
                // ignore and fall back to default widths
            }
            XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const blob = new Blob([wbout], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        showToast('Daily sales exported.', 'success');
    }
}

function exportInventoryCSV() {
    // Export only low-stock items and include a 'Low' flag column for visibility
    const headers = ['ID','Name','Brand','Type','Size','Color','Price','Quantity','ReorderPoint','Low'];
    const aoa = [headers];
    const lowStockItems = inventory.filter(item => Number(item.quantity || 0) <= Number(item.reorderPoint || 0));
    lowStockItems.forEach(item => {
        aoa.push([
            item.id || '',
            item.name || '',
            item.brand || '',
            item.type || '',
            item.size || '',
            item.color || '',
            Number(item.price || 0),
            Number(item.quantity || 0),
            Number(item.reorderPoint || 0),
            'YES'
        ]);
    });

    const filename = 'low-stock-' + (new Date().toISOString().slice(0,10)) + '.xlsx';
    if (typeof XLSX !== 'undefined') {
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        // compute widths
        const colCount = headers.length;
        const maxLens = new Array(colCount).fill(0);
        aoa.forEach(row => {
            for (let c = 0; c < colCount; c++) {
                const val = row[c] !== undefined && row[c] !== null ? String(row[c]) : '';
                maxLens[c] = Math.max(maxLens[c], Math.min(80, Math.ceil(val.length)));
            }
        });
        ws['!cols'] = maxLens.map(l => ({ wch: Math.max(8, Math.min(60, Math.ceil(l * 1.1))) }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Low Stock');
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const blob = new Blob([wbout], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        showToast('Low stock exported.', 'success');
    }
}

// Hash migration: convert any stored plaintext passwords into hashes immediately
async function migrateUserPasswords() {
    if (!users || !Array.isArray(users)) return;
    let mutated = false;
    for (let u of users) {
        if (u && u.password && !u.passwordHash) {
            try {
                u.passwordHash = await hashPassword(u.password);
                delete u.password;
                mutated = true;
            } catch (e) {
                console.error('Failed to migrate password for user', u.username, e);
            }
        }
    }
    if (mutated) saveState();
}

// Returns a SHA-256 hex string for the provided password using Web Crypto
async function hashPassword(password) {
    if (typeof password !== 'string') return '';
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

// Basic HTML escaping to avoid injection when composing markup from user inputs
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>'"\/]/g, function (s) {
        return ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
            '/': '&#x2F;'
        })[s];
    });
}

// Create a plain-text summary of items for audit/export purposes
function generateAuditItemText(items) {
    if (!items || !Array.isArray(items) || items.length === 0) return '-';
    // Return a bullet list separated by newlines so Excel/Sheets will show multi-line cells
    const lines = items.map(i => `• ${Number(i.quantity||0)}x ${i.brand||''} - ${i.name||''} (${i.type||''}, ${i.size||''}, ${i.color||''})`);
    // Use CRLF to be more compatible with Excel/Sheets multiline cells
    return lines.join('\r\n');
}

// Convert plain text (newline separated or bullet-prefixed) into an HTML <ul> list
function textToList(text) {
    if (!text) return '<span style="color:#777">-</span>';
    const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');
    if (!lines.length) return '<span style="color:#777">-</span>';
    const lis = lines.map(l => {
        // strip leading bullet characters
        const cleaned = l.replace(/^[-•\*\u2022\s]+/, '');
        return `<li>${escapeHtml(cleaned)}</li>`;
    }).join('');
    return `<ul class="audit-item-list">${lis}</ul>`;
}

// Generic print helper for the currently visible modal content
function printModal() {
    // allow any rendering to settle
    setTimeout(() => window.print(), 100);
}

// Export transactions for a specific staff user
function printStaffTransactions(staffUsername) {
    const staffLogs = auditLog.filter(log => log.staffUsername === (staffUsername || currentUserName))
                                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    if (staffLogs.length === 0) {
        showToast("No transactions to print.", "info");
        return;
    }
    
    let tableContent = "";
    staffLogs.forEach(log => {
        let itemsHtml = log.itemsText ? textToList(log.itemsText.replace(/\n/g, "<br>")) : (log.items ? textToList(stripTags(log.items)) : '-');
        const statusClass = log.status ? log.status.toLowerCase() : '';
        const statusDisplay = log.status ? `<span class="audit-status ${statusClass}">${log.status}</span>` : '-';
        tableContent += `
            <tr>
                <td>${escapeHtml(log.timestamp)}</td>
                <td>${escapeHtml(log.staffName || '')}</td>
                <td>${escapeHtml(log.action || '-')}</td>
                <td>${escapeHtml(log.customerName || '-')}</td>
                <td>${escapeHtml(log.transactionID || '-')}</td>
                <td class="textCenter">${statusDisplay}</td>
                <td class="audit-items-col">${itemsHtml}</td>
                <td class="amount-col">₱${log.amount ? Number(log.amount).toFixed(2) : '0.00'}</td>
            </tr>
        `;
    });

    const myCompletedReceipts = purchaseHistory.filter(p => p.staffUsername === (staffUsername || currentUserName) && p.status === 'completed');
    const myRevenue = myCompletedReceipts.reduce((s, r) => s + (r.subtotal || 0), 0);
    const user = users.find(u => u.username === (staffUsername || currentUserName)) || {};

    const reportHtml = `
        <div id="modalContent" class="modalContent-fullscreen">
            <div class="modalHeader">
                <h3>My Transactions Report</h3>
            </div>
            <div class="modal-body-scroll">
                <p><strong>Staff:</strong> ${escapeHtml(user.firstName || '')} ${escapeHtml(user.lastName || '')}</p>
                <p><strong>Staff ID:</strong> ${escapeHtml(user.employeeId || '')}</p>
                <p style="margin-bottom: 10px; font-size: 1rem; color: #333; font-weight:700;">
                    My Total Completed Revenue: ₱${myRevenue.toFixed(2)}
                </p>
                <table class="report-table">
                    <thead>
                        <tr>
                            <th>Timestamp</th>
                            <th>Staff Name</th>
                            <th>Action</th>
                            <th>Customer</th>
                            <th>Transaction ID</th>
                            <th>Status</th>
                            <th>Items</th>
                            <th>Amount</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableContent}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    const printWindow = window.open('', '', 'height=800,width=1200');
    printWindow.document.write('<html><head><title>My Transactions</title>');
    printWindow.document.write('<link rel="stylesheet" href="style.css" type="text/css">');
    printWindow.document.write('</head><body>');
    printWindow.document.write(reportHtml);
    printWindow.document.write('</body></html>');
    printWindow.document.close();
    
    setTimeout(() => {
        try {
            printWindow.print();
        } catch (e) {
            console.warn('printWindow.print failed', e);
        }
        printWindow.close();
    }, 500);
}

// Strip HTML tags (simple) for fallback when items are stored as HTML
function stripTags(html) {
    if (!html) return '';
    let s = String(html);
    // Convert common block/line breaks into newlines so list items stay separated
    s = s.replace(/<\s*br\s*\/?>/gi, '\n');
    s = s.replace(/<\s*\/li\s*>/gi, '\n');
    s = s.replace(/<\s*li[^>]*>/gi, '\n');
    s = s.replace(/<\s*\/p\s*>/gi, '\n');
    s = s.replace(/<\s*p[^>]*>/gi, '\n');
    s = s.replace(/<\s*\/div\s*>/gi, '\n');
    s = s.replace(/<\s*div[^>]*>/gi, '\n');
    // Remove any remaining tags
    s = s.replace(/<[^>]+>/g, '');
    // Normalize line endings and collapse multiple blank lines, trim each line
    s = s.replace(/\r\n?/g, '\n');
    const lines = s.split('\n').map(l => l.replace(/\s{2,}/g, ' ').trim()).filter(l => l !== '');
    return lines.join('\n').trim();
}

// Export Audit Trail (latest state per transaction) with staff employee ID included
function exportAuditTrail() {
    // Build latest logs grouped by transactionID
    const grouped = {};
    auditLog.forEach(log => {
        if (!log.transactionID) return;
        if (!grouped[log.transactionID]) grouped[log.transactionID] = [];
        grouped[log.transactionID].push(log);
    });

    const latestLogs = Object.values(grouped).map(arr => arr[arr.length - 1]);
    // Headers include staff username and employee id
    const headers = ['TransactionID','LatestUpdate','StaffUsername','StaffName','EmployeeID','Customer','Status','Items','Amount'];
    const aoa = [headers];
    latestLogs.forEach(log => {
        // Try to use the live receipt to get items (and mark refunded items) and current subtotal
        const receipt = purchaseHistory.find(p => p.transactionID === log.transactionID);
        let safeItems = '';
        if (receipt && Array.isArray(receipt.items)) {
            // Build a plain-text list and annotate refunded items
            safeItems = receipt.items.map(i => `${i.quantity}x ${i.brand || ''} - ${i.name || ''} (${i.type || ''}, ${i.size || ''}, ${i.color || ''})${i.refunded ? ' [REFUNDED]' : ''}`).join('\n');
        } else if (log.itemsText) {
            safeItems = log.itemsText;
        } else if (Array.isArray(log.items)) {
            safeItems = generateAuditItemText(log.items);
        } else if (log.items) {
            safeItems = stripTags(log.items);
        } else {
            safeItems = '-';
        }

        const amountVal = receipt ? Number(receipt.subtotal || 0) : Number(log.amount || 0);

        aoa.push([
            log.transactionID || '',
            log.timestamp || '',
            log.staffUsername || '',
            log.staffName || '',
            log.employeeId || '',
            log.customerName || '',
            log.status || '',
            safeItems,
            amountVal
        ]);
    });

    const filename = 'audit-trail-' + (new Date().toISOString().slice(0,10)) + '.xlsx';
    if (typeof XLSX !== 'undefined') {
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const colCount = headers.length;
        const maxLens = new Array(colCount).fill(0);
        aoa.forEach(row => {
            for (let c = 0; c < colCount; c++) {
                const val = row[c] !== undefined && row[c] !== null ? String(row[c]) : '';
                maxLens[c] = Math.max(maxLens[c], Math.min(120, Math.ceil(val.length)));
            }
        });
        ws['!cols'] = maxLens.map(l => ({ wch: Math.max(10, Math.min(80, Math.ceil(l * 1.1))) }));
        // Ensure Items column preserves multiline content and attempts to set wrapText
        try {
            const itemsColIndex = headers.indexOf('Items');
            if (itemsColIndex >= 0) {
                for (let r = 1; r < aoa.length; r++) {
                    const cellAddr = XLSX.utils.encode_cell({ c: itemsColIndex, r });
                    if (!ws[cellAddr]) ws[cellAddr] = { t: 's', v: String(aoa[r][itemsColIndex] || '') };
                    else { ws[cellAddr].t = 's'; ws[cellAddr].v = String(aoa[r][itemsColIndex] || ''); }
                    try { ws[cellAddr].s = Object.assign(ws[cellAddr].s || {}, { alignment: Object.assign((ws[cellAddr].s && ws[cellAddr].s.alignment) || {}, { wrapText: true }) }); } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { /* ignore */ }

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Audit Trail');
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
        const blob = new Blob([wbout], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        showToast('Audit trail exported.', 'success');
    }
}

// work without needing inline onclick attributes or a page refresh.
document.addEventListener('click', function(e) {
    const t = e.target.closest && e.target.closest('.toggle-password');
    if (!t) return;
    // Allow inline onclick to still work if present
    try {
        // Look for a data-target attribute first
        let targetId = t.getAttribute && t.getAttribute('data-target');
        if (!targetId) {
            // Fallback: find an input inside same password-wrapper
            const wrapper = t.closest('.password-wrapper');
            if (wrapper) {
                const input = wrapper.querySelector('input[type="password"], input');
                if (input) targetId = input.id;
            }
        }
        if (targetId) togglePasswordVisibility(targetId, t);
    } catch (err) {
        // ignore
    }
});
