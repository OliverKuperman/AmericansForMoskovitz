'use strict';

// ─── Mobile Navigation Toggle ─────────────────────────────────────────────────
(function () {
  const toggle = document.querySelector('.nav-toggle');
  const links  = document.querySelector('.nav-links');
  if (!toggle || !links) return;

  toggle.addEventListener('click', () => {
    const isOpen = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });

  // Close menu when a link is clicked
  links.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      links.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });
})();

// ─── Active Nav Link ──────────────────────────────────────────────────────────
(function () {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(link => {
    const href = link.getAttribute('href') || '';
    if (href === page || (page === '' && href === 'index.html')) {
      link.classList.add('active');
    }
  });
})();

// ─── Signature Counter (all pages) ───────────────────────────────────────────
async function loadSignatureCount(selectors) {
  try {
    const res  = await fetch('/api/petition/count');
    if (!res.ok) return;
    const data = await res.json();
    const count = (data.count ?? 0).toLocaleString();
    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => { el.textContent = count; });
    });
  } catch (_) { /* non-critical */ }
}

loadSignatureCount(['.sig-num', '.count-num']);

// ─── Petition Form ────────────────────────────────────────────────────────────
(function () {
  const form    = document.getElementById('petition-form');
  if (!form) return;

  const nameInput   = document.getElementById('input-name');
  const emailInput  = document.getElementById('input-email');
  const nameError   = document.getElementById('name-error');
  const emailError  = document.getElementById('email-error');
  const formMsg     = document.getElementById('form-message');
  const submitBtn   = document.getElementById('submit-btn');
  const submitText  = document.getElementById('submit-text');

  const NAME_RE  = /^[A-Za-z\s'\-\.]{2,100}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function showFieldError(input, errorEl, msg) {
    input.classList.add('field-error');
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }

  function clearFieldError(input, errorEl) {
    input.classList.remove('field-error');
    errorEl.style.display = 'none';
  }

  function showFormMessage(type, msg) {
    formMsg.className = 'form-message ' + type;
    formMsg.textContent = msg;
    formMsg.style.display = 'block';
  }

  function setLoading(loading) {
    submitBtn.disabled = loading;
    submitText.textContent = loading ? 'Submitting…' : 'Sign the Petition';
  }

  // Real-time validation on blur
  nameInput.addEventListener('blur', () => {
    const v = nameInput.value.trim();
    if (!v || !NAME_RE.test(v)) {
      showFieldError(nameInput, nameError, 'Please enter a valid name (letters, spaces, hyphens, apostrophes).');
    } else {
      clearFieldError(nameInput, nameError);
    }
  });

  emailInput.addEventListener('blur', () => {
    const v = emailInput.value.trim();
    if (!v || !EMAIL_RE.test(v)) {
      showFieldError(emailInput, emailError, 'Please enter a valid email address.');
    } else {
      clearFieldError(emailInput, emailError);
    }
  });

  // Clear errors on input
  [nameInput, emailInput].forEach(input => {
    input.addEventListener('input', () => {
      input.classList.remove('field-error');
    });
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    formMsg.style.display = 'none';

    const name  = nameInput.value.trim();
    const email = emailInput.value.trim();
    let valid   = true;

    if (!name || !NAME_RE.test(name)) {
      showFieldError(nameInput, nameError, 'Please enter a valid full name.');
      valid = false;
    } else {
      clearFieldError(nameInput, nameError);
    }

    if (!email || !EMAIL_RE.test(email)) {
      showFieldError(emailInput, emailError, 'Please enter a valid email address.');
      valid = false;
    } else {
      clearFieldError(emailInput, emailError);
    }

    if (!valid) return;

    setLoading(true);

    try {
      const res  = await fetch('/api/petition', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, email }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        showFormMessage('success',
          `Thank you, ${name}! Your signature has been recorded. You are among ${data.count.toLocaleString()} Americans who have signed.`
        );
        form.reset();
        // Update all counters on page
        document.querySelectorAll('.sig-num, .count-num').forEach(el => {
          el.textContent = data.count.toLocaleString();
        });
        submitBtn.disabled = true;
        submitText.textContent = 'Petition Signed ✓';
      } else {
        showFormMessage('error', data.error || 'An error occurred. Please try again.');
        setLoading(false);
      }
    } catch (_) {
      showFormMessage('error', 'A network error occurred. Please check your connection and try again.');
      setLoading(false);
    }
  });
})();
