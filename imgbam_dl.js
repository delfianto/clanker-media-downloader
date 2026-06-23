// ==UserScript==
// @name          ImgBam Downloader
// @namespace     http://tampermonkey.net/
// @version       2.0
// @description   One click download for ImageBam with cache-aware instant download and visual feedback
// @author        Naked Ojisan
// @match         https://www.imagebam.com/image/*
// @match         https://www.imagebam.com/view/*
// @icon          https://www.google.com/s2/favicons?sz=64&domain=imagebam.com
// @grant         GM_download
// @grant         GM_xmlhttpRequest
// @connect       *
// ==/UserScript==

const uuidRegex = /^[0-9a-f]{8}\b-[0-9a-f]{4}\b-[0-9a-f]{4}\b-[0-9a-f]{4}\b-[0-9a-f]{12}$/gi;
const v1Regex = /^[a-f0-9]{5,6}(\d+)$/;

// Inject CSS for the spinner and fade-out effect
(function() {
    const style = document.createElement('style');
    style.type = 'text/css';
    style.innerHTML = `
    .imgbam-feedback-container {
        display: none; /* Hidden by default when no operation */
        vertical-align: middle;
        margin-left: 10px; /* Adjust spacing as needed */
    }

    .imgbam-feedback-container.active {
        display: inline-block; /* Show when active */
    }

    .imgbam-spinner {
        border: 4px solid #f3f3f3; /* Light grey */
        border-top: 4px solid #3498db; /* Blue */
        border-radius: 50%;
        width: 16px;
        height: 16px;
        animation: spin 1s linear infinite;
        display: inline-block;
        vertical-align: middle;
        opacity: 1; /* Fully opaque by default when container is active */
        transition: opacity 0.5s ease-out; /* Fade transition */
    }

    .imgbam-download-status {
        font-weight: bold;
        vertical-align: middle;
        margin-left: 5px; /* Spacing between spinner and text */
        opacity: 1; /* Fully opaque by default when container is active */
        transition: opacity 0.5s ease-out; /* Fade transition */
    }

    /* Class to trigger fade-out animation */
    .imgbam-feedback-fading {
        opacity: 0 !important;
    }

    @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }
    `;
    document.head.appendChild(style);
})();

const imgBam = (function() {
    let feedbackContainer = null;
    let spinnerElement = null;
    let statusElement = null;
    let fadeOutTimeout = null; // To store the timeout ID for fading out
    let hideDisplayTimeout = null; // To store the timeout ID for hiding display

    function createFeedbackElements() {
        const fileNameSpan = document.querySelector('span.name.text-ellipsis');
        if (fileNameSpan) {
            // Create a container for the feedback elements
            feedbackContainer = document.createElement('span');
            feedbackContainer.className = 'imgbam-feedback-container';
            fileNameSpan.parentNode.insertBefore(feedbackContainer, fileNameSpan.nextSibling);

            // Create spinner inside the container
            spinnerElement = document.createElement('span');
            spinnerElement.className = 'imgbam-spinner';
            feedbackContainer.appendChild(spinnerElement);

            // Create status text element inside the container
            statusElement = document.createElement('span');
            statusElement.className = 'imgbam-download-status';
            feedbackContainer.appendChild(statusElement);
        }
    }

    function showFeedback(message, color = 'blue') {
        // Clear any existing fade-out or hide-display timeouts
        if (fadeOutTimeout) {
            clearTimeout(fadeOutTimeout);
            fadeOutTimeout = null;
        }
        if (hideDisplayTimeout) {
            clearTimeout(hideDisplayTimeout);
            hideDisplayTimeout = null;
        }

        // Make the container visible
        if (feedbackContainer) {
            feedbackContainer.classList.add('active');
            // Ensure elements are fully opaque before starting operation
            spinnerElement.classList.remove('imgbam-feedback-fading');
            statusElement.classList.remove('imgbam-feedback-fading');
        }

        // Update status text and color
        if (statusElement) {
            statusElement.textContent = message;
            statusElement.style.color = color;
        }
    }

    function hideFeedback(message, color, displayHideDelay = 500) { // displayHideDelay matches CSS transition
        if (statusElement) {
            statusElement.textContent = message;
            statusElement.style.color = color;
        }

        // Trigger the fade-out animation
        if (spinnerElement) {
            spinnerElement.classList.add('imgbam-feedback-fading');
        }
        if (statusElement) {
            statusElement.classList.add('imgbam-feedback-fading');
        }

        // After fade-out, hide the entire container (display: none)
        hideDisplayTimeout = setTimeout(() => {
            if (feedbackContainer) {
                feedbackContainer.classList.remove('active'); // This sets display: none;
                // Clean up fading classes for next use
                spinnerElement.classList.remove('imgbam-feedback-fading');
                statusElement.classList.remove('imgbam-feedback-fading');
            }
        }, displayHideDelay); // Wait for the fade transition to complete
    }

    return {
        init: function() {
            createFeedbackElements();
            const button = document.querySelector('a.dropdown-item[target="_blank"]');

            if (button == undefined) {
                return;
            }

            // Grab the displayed image's exact src ---
            const displayedImage = document.querySelector('img.main-image');

            // Prioritize the loaded image's src to hit the cache.
            // If it fails to find the image for some reason, fallback to the button's href.
            const targetUrl = displayedImage ? displayedImage.src : button.href;

            console.log('Targeting image URL: ' + targetUrl);

            // Hijack the original download button
            button.href = 'javascript:void(0);';
            button.removeAttribute('target');

            return {
                url: targetUrl,
                button: button,
                fileName: this.name()
            };
        },
        name: function() {
            const fileNameSpan = document.querySelector('span.name.text-ellipsis');
            const origName = fileNameSpan ? fileNameSpan.innerText : '';
            const segment = origName.split('.');

            console.log(`Original file name: ${origName}`);
            if (!uuidRegex.test(segment[0])) {
                return origName;
            }

            const fileId = window.location.href.split('/').pop();
            const newName = v1Regex.test(fileId) ? fileId.match(v1Regex)[1] : fileId;

            return `${newName}.${segment[1]}`;
        },
        download: function(dl) {
            console.log(`Downloading file ${dl.fileName}`);
            console.log(`Downloading from ${dl.url}`);

            showFeedback('Downloading...'); // Show feedback and spinner

            // Use GM_xmlhttpRequest to bypass CORS and leverage HTTP cache
            GM_xmlhttpRequest({
                method: 'GET',
                url: dl.url,
                responseType: 'blob',
                onload: function(response) {
                    console.log('Download response received:', response);

                    // Check if we got a valid blob
                    if (response.response && response.response instanceof Blob) {
                        const blob = response.response;

                        // Create download using object URL
                        const url = URL.createObjectURL(blob);
                        const anchor = document.createElement('a');
                        anchor.download = dl.fileName;
                        anchor.href = url;
                        anchor.click();

                        // Cleanup
                        setTimeout(() => URL.revokeObjectURL(url), 100);

                        console.log('Downloaded successfully!');
                        hideFeedback('Downloaded!', 'green');
                    } else {
                        console.error('Invalid response blob');
                        hideFeedback('Download Failed!', 'red');
                    }
                },
                onprogress: function(progress) {
                    if (progress.total && progress.loaded) {
                        const percent = Math.round((progress.loaded / progress.total) * 100);
                        if (statusElement) {
                            statusElement.textContent = `Downloading (${percent}%)...`;
                        }
                    }
                    console.log('Progress:', progress);
                },
                onerror: function(error) {
                    console.error('Download error:', error);
                    hideFeedback('Download Failed!', 'red');
                },
                ontimeout: function() {
                    console.error('Download timed out.');
                    hideFeedback('Download Timed Out!', 'red');
                }
            });
        }
    };
})();

(function() {
    const dl = imgBam.init();

    if (dl == undefined) {
        return;
    }

    dl.button.onclick = function() {
        imgBam.download(dl);
    };
})();
