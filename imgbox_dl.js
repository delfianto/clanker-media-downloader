// ==UserScript==
// @name          ImgBox Downloader
// @namespace     http://tampermonkey.net/
// @version       1.2
// @description   One click download for ImgBox with a visual feedback
// @author        Naked Ojisan
// @match         https://imgbox.com/*
// @icon          https://www.google.com/s2/favicons?sz=64&domain=imgbox.com
// @grant         GM_download
// ==/UserScript==

(function() {
    'use strict';

    const btn_download_icon = document.querySelector('.icon-cloud-download');
    const btn_download_parent = btn_download_icon?.parentNode;
    const img_filename = document.querySelector('.image-content')?.title;

    if (btn_download_parent && img_filename) {
        const url = btn_download_parent.href;
        btn_download_parent.setAttribute('href', 'javascript:void(0)'); // Prevent default navigation

        btn_download_parent.onclick = function(event) {
            event.preventDefault(); // Ensure default link behavior is stopped

            // Disable the button to prevent multiple clicks
            btn_download_parent.style.pointerEvents = 'none';
            btn_download_parent.style.opacity = '0.6'; // Visually indicate it's disabled

            // Replace the icon with a spinner
            if (btn_download_icon) {
                btn_download_icon.classList.remove('icon-cloud-download');
                btn_download_icon.classList.add('spinner'); // Add a spinner class

                // Spinner specific styles
                btn_download_icon.style.display = 'inline-block'; // Essential for sizing
                btn_download_icon.style.width = '1em'; // Match approximate icon size
                btn_download_icon.style.height = '1em'; // Match approximate icon size
                btn_download_icon.style.border = '0.15em solid rgba(255, 255, 255, 0.3)';
                btn_download_icon.style.borderTop = '0.15em solid #fff';
                btn_download_icon.style.borderRadius = '50%';
                btn_download_icon.style.animation = 'spin 1s linear infinite';
                btn_download_icon.style.verticalAlign = 'middle'; // Align with text if any
                btn_download_icon.style.margin = '0'; // Remove any default margin from the icon font
                btn_download_icon.style.fontSize = 'inherit'; // Ensure font-size doesn't override
            }

            console.log('Downloading ' + img_filename);
            GM_download({
                url: url,
                name: img_filename,
                onload: function() {
                    console.log('Download complete: ' + img_filename);
                    // Re-enable the button and restore the icon after download
                    btn_download_parent.style.pointerEvents = 'auto';
                    btn_download_parent.style.opacity = '1';

                    if (btn_download_icon) {
                        btn_download_icon.classList.remove('spinner');
                        btn_download_icon.classList.add('icon-cloud-download');
                        // Remove spinner specific styles
                        btn_download_icon.style.display = '';
                        btn_download_icon.style.width = '';
                        btn_download_icon.style.height = '';
                        btn_download_icon.style.border = '';
                        btn_download_icon.style.borderTop = '';
                        btn_download_icon.style.borderRadius = '';
                        btn_download_icon.style.animation = '';
                        btn_download_icon.style.verticalAlign = '';
                        btn_download_icon.style.margin = '';
                        btn_download_icon.style.fontSize = '';
                    }
                },
                onerror: function(error) {
                    console.error('Download failed for ' + img_filename, error);
                    // Re-enable the button on error
                    btn_download_parent.style.pointerEvents = 'auto';
                    btn_download_parent.style.opacity = '1';

                    if (btn_download_icon) {
                        btn_download_icon.classList.remove('spinner');
                        btn_download_icon.classList.add('icon-cloud-download');
                        // Remove spinner specific styles
                        btn_download_icon.style.display = '';
                        btn_download_icon.style.width = '';
                        btn_download_icon.style.height = '';
                        btn_download_icon.style.border = '';
                        btn_download_icon.style.borderTop = '';
                        btn_download_icon.style.borderRadius = '';
                        btn_download_icon.style.animation = '';
                        btn_download_icon.style.verticalAlign = '';
                        btn_download_icon.style.margin = '';
                        btn_download_icon.style.fontSize = '';
                    }
                }
            });
        };

        // Add CSS for the spinner animation
        const style = document.createElement('style');
        style.type = 'text/css';
        style.innerHTML = `
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        `;
        document.head.appendChild(style);
    }
})();
