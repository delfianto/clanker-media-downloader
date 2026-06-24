# ImgBox

## What it does
- Single download button injection.
- CDN → viewer redirect.
- Gallery batch download.

## Quirks & Nonsense
ImgBox is fairly normal, but it gets an 8-character path guard regex to make sure we don't inject download buttons on random non-viewer pages. It also features a thumbnail→full-res URL transform so we don't even have to fetch the viewer page to get the direct image link. Bandwidth saved, polar bears cheered.

## The Thumbnail Redirect
Much like ImageBam, if you accidentally open an ImgBox thumbnail directly, the extension jumps in. The `document_start` script uses regex (`^https?://thumbs\d+\.imgbox\.com/[a-zA-Z0-9]+/[a-zA-Z0-9]+/([a-zA-Z0-9]+)_t\.jpg$`) to snatch the file ID out of the thumbnail URL.

We then immediately fire a `location.replace()` to bounce you to `https://imgbox.com/$1`. This ensures you always land on the full-size viewer page where you can actually see the image and use the download button.
