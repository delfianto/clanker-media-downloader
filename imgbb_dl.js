// ==UserScript==
// @name            ImgBB Downloader
// @namespace       http://tampermonkey.net/
// @version         0.1
// @description     Auto redirect to download link for IBB image hoster
// @author          Naked Ojisan
// @match           https://ibb.co/*
// @icon            https://simgbb.com/images/favicon.png
// @require         http://code.jquery.com/jquery-3.6.4.min.js
// @grant            GM_download
// ==/UserScript==
/* globals jQuery */

jQuery(document).ready(function() {
    const btn = jQuery('a.btn-download');

    if (btn === undefined) {
        return;
    }

    const link = btn.attr('href');
    const file = btn.attr('download');
    btn.attr('href', '#');

    btn.click(function(e) {
        e.preventDefault();
        GM_download({
            url: link,
            name: file,
            saveAs: false,
            onload: result => {
                console.log(result);
            },
            onprogress: result => {
                console.log(result);
            }
        });
    });
});
