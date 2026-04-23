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

// ─── Email Verification Result (handles ?verified=1 and ?verify_error=… in URL) ──
(function () {
  const form    = document.getElementById('petition-form');
  const formMsg = document.getElementById('form-message');
  const submitBtn  = document.getElementById('submit-btn');
  const submitText = document.getElementById('submit-text');
  if (!formMsg) return;

  const params = new URLSearchParams(window.location.search);

  if (params.get('verified') === '1') {
    // Successful email verification — hide form, show permanent success
    if (form) form.style.display = 'none';
    formMsg.className     = 'form-message success';
    formMsg.innerHTML     = '✓ Your signature has been confirmed! Thank you for supporting Americans for Moskovitz.';
    formMsg.style.display = 'block';
    // Refresh counter now that a new confirmed signature was added
    loadSignatureCount(['.sig-num', '.count-num']);
    // Clean up URL bar without reloading
    window.history.replaceState({}, '', '/petition.html');
    return;
  }

  const verifyError = params.get('verify_error');
  if (verifyError) {
    const msgs = {
      expired: 'Your verification link has expired (links are valid for 24 hours). Please re-submit the form below to receive a new one.',
      invalid: 'That verification link is invalid. Please re-submit the form below.',
      server:  'A server error occurred while verifying your email. Please try again.',
    };
    formMsg.className     = 'form-message error';
    formMsg.textContent   = msgs[verifyError] || msgs.server;
    formMsg.style.display = 'block';
    window.history.replaceState({}, '', '/petition.html');
  }
})();

// ─── Petition Form ────────────────────────────────────────────────────────────
(function () {
  const form    = document.getElementById('petition-form');
  if (!form) return;

  const nameInput     = document.getElementById('input-name');
  const emailInput    = document.getElementById('input-email');
  const citizenBox    = document.getElementById('us-citizen');
  const nameError     = document.getElementById('name-error');
  const emailError    = document.getElementById('email-error');
  const citizenError  = document.getElementById('citizen-error');
  const formMsg       = document.getElementById('form-message');
  const submitBtn     = document.getElementById('submit-btn');
  const submitText    = document.getElementById('submit-text');

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

    if (!citizenBox.checked) {
      showFieldError(citizenBox, citizenError, 'You must confirm that you are a US citizen.');
      valid = false;
    } else {
      clearFieldError(citizenBox, citizenError);
    }

    if (!valid) return;

    setLoading(true);

    try {
      const res  = await fetch('/api/petition', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, email, usCitizen: true }),
      });

      const data = await res.json();

      if (res.ok && data.pending) {
        // Verification email sent — do not count signature yet
        showFormMessage('success',
          `Almost there, ${name}! We've sent a confirmation email to ${email}. ` +
          `Please check your inbox (and spam folder) and click the link to confirm your signature.`
        );
        form.reset();
        submitBtn.disabled = true;
        submitText.textContent = 'Check Your Email ✉';
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
