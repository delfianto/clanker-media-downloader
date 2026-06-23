IMAGEBAM
---
^.+(?:thumbs\d+|images\d+)\.(imagebam\.com)(?:\/[a-f0-9]{2}){3}\/([A-Z0-9]{7,})_[o|t]\.(?:gif|jpe?g|png)
https://$1/view/$2

IMAGEBAM (OLD PATTERN)
---
^.+(?:images|thumbs)\d\.imagebam\.com\/(?:[a-f0-9]{2}\/){3}([a-z0-9]+)\.(?:png|jpg|jpeg|gif)$
https://imagebam.com/image/$1

IMGBOX
---
^.+(?:thumbs\d+|images\d+)\.(imgbox\.com)(?:\/[a-f0-9]{2}){2}\/(.{8,})_[b|o|t]\.(?:gif|jpe?g|png)
https://$1/$2
