// --- NOTIFICATION SYSTEM (GLOBAL) ---
window.addNotification = function(msg) {
    let notifs = JSON.parse(localStorage.getItem('user_notifications') || '[]');
    notifs.unshift({msg: msg, time: new Date().toLocaleTimeString(), id: Date.now()});
    localStorage.setItem('user_notifications', JSON.stringify(notifs));
    if(window.updateNotificationBell) window.updateNotificationBell();
};

window.showNotifications = function() {
    let notifs = JSON.parse(localStorage.getItem('user_notifications') || '[]');
    const lang = document.documentElement.lang || 'es';
    const isDark = document.documentElement.classList.contains('dark');
    
    if(notifs.length === 0) {
        Swal.fire({
            title: translations[lang]['notif_empty'] || "Sin Notificaciones",
            icon: "info",
            toast: true,
            position: 'top-end',
            showConfirmButton: false,
            timer: 2500,
            background: isDark ? '#191c1d' : '#fff',
            color: isDark ? '#fff' : '#000'
        });
        return;
    }
    
    let htmlContent = '<div class="text-left space-y-2 mt-4 max-h-[380px] overflow-y-auto pr-1 custom-scrollbar">';
    notifs.slice(0, 20).forEach(n => {
        htmlContent += `<div class="p-3 bg-surface-container-low dark:bg-white/5 rounded-xl border border-outline-variant/20 shadow-sm transition-all hover:bg-surface-container">
            <p class="text-xs font-semibold text-on-surface dark:text-white leading-snug">${n.msg}</p>
            <p class="text-[9px] text-secondary mt-1 font-mono">${n.time}</p>
        </div>`;
    });
    htmlContent += '</div>';

    Swal.fire({
        title: translations[lang]['notif_title'] || "Centro de Alertas",
        html: htmlContent,
        showCancelButton: true,
        cancelButtonText: translations[lang]['notif_close'] || "Cerrar",
        confirmButtonText: translations[lang]['notif_clean'] || "Limpiar Historial",
        confirmButtonColor: "#ba1a1a",
        background: isDark ? '#191c1d' : '#fff',
        color: isDark ? '#fff' : '#000',
        customClass: { 
            popup: 'rounded-3xl border border-outline-variant/10 shadow-2xl',
            title: 'font-headline font-black text-xl pt-4',
            cancelButton: 'rounded-xl font-bold px-6',
            confirmButton: 'rounded-xl font-bold px-6'
        }
    }).then(result => {
        if(result.isConfirmed) {
            localStorage.setItem('user_notifications', '[]');
            if(window.updateNotificationBell) window.updateNotificationBell();
            Swal.fire({
                toast: true, 
                position: 'top-end', 
                icon: 'success', 
                title: translations[lang]['notif_cleaned'] || 'Notificaciones limpiadas', 
                showConfirmButton: false, 
                timer: 1500,
                background: isDark ? '#191c1d' : '#fff',
                color: isDark ? '#fff' : '#000'
            });
        }
    });
};

window.updateNotificationBell = function() {
    let notifs = JSON.parse(localStorage.getItem('user_notifications') || '[]');
    let bells = document.querySelectorAll('.notification-badge');
    bells.forEach(b => {
        if(notifs.length > 0) b.classList.remove('hidden');
        else b.classList.add('hidden');
    });
};

// --- PREVENT ICON TRANSLATION ---
function protectIcons() {
    document.querySelectorAll('.material-symbols-outlined').forEach(el => {
        el.setAttribute('translate', 'no');
        el.classList.add('notranslate');
    });
}

// --- GLOBAL STATE MANAGER (THEME & i18n) ---
function updateLanguage(lang) {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (translations[lang] && translations[lang][key]) {
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                if (el.hasAttribute('placeholder')) {
                    el.placeholder = translations[lang][key];
                } else {
                    el.value = translations[lang][key];
                }
            } else {
                el.innerText = translations[lang][key];
            }
        }
    });
    
    // Update toggle label to show Destination language
    document.querySelectorAll('[data-lang-toggle]').forEach(el => {
        el.innerText = lang === 'es' ? 'EN' : 'ES';
    });

    document.documentElement.lang = lang;
    localStorage.setItem('language', lang);
    
    // Dispatch event for components like Charts
    window.dispatchEvent(new CustomEvent('languageChanged', { detail: lang }));
}

function toggleTheme() {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    updateMapTheme(isDark);
}

function updateMapTheme(isDark) {
    if (typeof updateMapLayer === 'function') {
        updateMapLayer(isDark);
    }
}

window.toggleSidebar = function() {
    const sidebar = document.getElementById('mainSidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (sidebar && backdrop) {
        sidebar.classList.toggle('-translate-x-full');
        backdrop.classList.toggle('hidden');
        // Notify dynamic components (like the map) that the layout changed
        window.dispatchEvent(new Event('resize'));
    }
};

// Global initialization
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    const savedLang = localStorage.getItem('language') || 'es';
    
    updateLanguage(savedLang);
    window.updateNotificationBell();
    protectIcons();
    
    if (typeof updateMapTheme === 'function') updateMapTheme(savedTheme === 'dark');

    // Sidebar close on backdrop click if needed (redundant if already in HTML onclick, but safer here)
    const backdrop = document.getElementById('sidebarBackdrop');
    if (backdrop) {
        backdrop.onclick = window.toggleSidebar;
    }

    // Watch for dynamic icons
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.addedNodes.length) protectIcons();
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
