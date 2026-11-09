'use strict';
async function toggleRole(userId) {
            try {
                const response = await fetch(`/api/admin/toggle_role/${userId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRFToken': document.querySelector('meta[name="csrf-token"]').content }
                });

                const data = await response.json();

                if (response.ok) {
                    const badge = document.getElementById(`role-badge-${userId}`);
                    if (data.new_role === 'admin') {
                        badge.className = "px-2 py-1 rounded text-xs font-bold uppercase tracking-wider bg-alert/20 text-alert border border-alert/30";
                        badge.innerText = "admin";
                    } else {
                        badge.className = "px-2 py-1 rounded text-xs font-bold uppercase tracking-wider bg-slate-700 text-slate-300 border border-slate-600";
                        badge.innerText = "user";
                    }
                } else {
                    alert('Error: ' + data.error);
                }
            } catch (error) {
                alert('Connection error occurred.');
            }
        }

        async function deleteUser(userId, username) {
            if (confirm(`CRITICAL WARNING: Are you sure you want to PERMANENTLY terminate operator '${username}'?`)) {
                try {
                    const response = await fetch(`/api/admin/delete/${userId}`, {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': document.querySelector('meta[name="csrf-token"]').content }
                    });

                    if (response.ok) {
                        document.getElementById(`user-row-${userId}`).remove();
                    } else {
                        const data = await response.json();
                        alert('Error: ' + data.error);
                    }
                } catch (error) {
                    alert('Connection error occurred.');
                }
            }
        }

document.querySelectorAll('[data-role-toggle]').forEach(button => {
    button.addEventListener('click', () => toggleRole(Number(button.dataset.userId)));
});
document.querySelectorAll('[data-delete-user]').forEach(button => {
    button.addEventListener('click', () => deleteUser(Number(button.dataset.userId), button.dataset.username));
});
