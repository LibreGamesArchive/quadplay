/**
   \file quadplay-load.js
 
   Routines for handling asynchronous loading of the game from URLs.
   The main routine is:

   - `afterLoadGame`

   which schedules loading of the entire game into memory and then
   invokes a callback once all resources have been loaded.

   The following return a usable object immediately while scheduling
   asynchronous work to fill out that object:

   - `loadFont`
   - `loadSound`
   - `loadMap`
   - `loadSpritesheet`

   Also exports helpers `parseHexColor` and `parseHex`
*/
"use strict";

// Allocated by afterLoadGame
let loadManager = null;

let lastSpriteID = 0;

function onLoadFileStart(url) {
    console.log('Fetching "' + url + '"');
    appendToBootScreen('Fetching ' + url.replace(/^.*\//, ''));
}

// Invoked when any file load completes
function onLoadFileComplete(url) {
    console.log('Processing "' + url + '"');
    appendToBootScreen('Processing ' + url.replace(/^.*\//, ''));
}

/** Allows leading zeros. Returns a number on [0, 1] */
function parseHex(str) {
    const div = (str.length === 2) ? 255 : 15

    // Remove leading zeros
    str = str.replace(/^0*/, '');
    if (str.length === 0) { return 0; }
    return parseInt(str, 16) / div;
}


function parseHexColor(str) {
    let r, g, b, a = 1;

    switch (str.length) {
    case 8: // RRGGBBAA
        a = parseHex(str.substring(6, 8));
        // Fall through
        
    case 6: // RRGGBB
        r = parseHex(str.substring(0, 2));
        g = parseHex(str.substring(2, 4));
        b = parseHex(str.substring(4, 6));
        break;
        
    case 4: // RGBA
        a = parseHex(str[3]);
        // Fall through
        
    case 3: // RGB
        r = parseHex(str[0]);
        g = parseHex(str[1]);
        b = parseHex(str[2]);
        break;
        
    case 2: // YY
        r = g = b = parseHex(str);
        break;
        
    case 1: // Y
        r = g = b = parseHex(str);
        break;
        
    default:
        throw new Error("Illegal hexadecimal color specification: '#" + str + "'");
    }
    
    return {r:r, g:g, b:b, a:a};
}


function afterLoadGame(gameURL, callback, errorCallback) {
    // Use a random starting ID so that programmers who don't read the
    // manual won't assume it will be the same for each run and start
    // hardcoding constants that future implementation changes may break.
    lastSpriteID = Math.round(Math.random() * 8192);
    
    loadManager = new LoadManager({
        callback: function () {
            computeAssetCredits(gameSource);
            if (callback) { callback(); }
        },
        errorCallback: errorCallback,
        jsonParser: 'permissive',
        forceReload: useIDE});

    quadplayLogoSprite = loadSpritesheet(
        '_quadplayLogoSprite',
        {url:'startup-logo.png', spriteSize:{x:63, y:36}},
        '', null, false);


    // If given a directory, assume that the file has the same name
    if (! /\.game\.json$/i.test(gameURL)) {
        // Remove trailing slash
        if (gameURL[gameURL.length - 1] === '/') { gameURL = gameURL.substring(0, gameURL.length - 1); }
        gameURL = gameURL.replace(/(\/|^)([^\/]+)$/, '$1$2/$2.game.json');
    }
    gameURL = makeURLAbsolute(location.href, gameURL);
    window.gameURL = gameURL;
    console.log('Loading ' + gameURL);
    
    // Wipe the cache
    fileContents = {};
    gameSource = {};
    
    resourceStats = {
        spritePixels: 0,
        spritesheets: 0,
        maxSpritesheetWidth: 0,
        maxSpritesheetHeight: 0,
        sourceStatements: 0,
        sounds: 0
    };

    loadManager.fetch(gameURL, 'json', null, function (gameJSON) {
        gameSource.jsonURL = gameURL;
        if (gameJSON.screenSize === undefined) {
            gameJSON.screenSize = {x: 384, y:224};
        }
        gameSource.json = gameJSON;
        fileContents[gameURL] = gameJSON;

        const allowedScreenSizes = [{x: 384, y: 224}, {x: 192, y: 112}, {x: 128, y: 128}, {x: 64, y: 64}];
        {
            let ok = false;
            for (let i = 0; i < allowedScreenSizes.length; ++i) {
                if ((allowedScreenSizes[i].x === gameJSON.screenSize.x) &&
                    (allowedScreenSizes[i].y === gameJSON.screenSize.y)) {
                    ok = true;
                }
            }
            if (! ok) {
                throw new Error(`${gameJSON.screenSize.x} x ${gameJSON.screenSize.y} is not a supported screen size.`);
            }
        }
        
        // Scripts:
        gameSource.scripts = [];
        if (gameJSON.scripts) {
            
            if (! Array.isArray(gameJSON.scripts)) {
                throw new Error('The scripts parameter is not an array in ' + gameURL);
            }
            
            for (let i = 0; i < gameJSON.scripts.length; ++i) {
                if (typeof gameJSON.scripts[i] !== 'string') {
                    throw new Error('Script ' + i + ' is not a url.');
                }
                
                const scriptURL = makeURLAbsolute(gameURL, gameJSON.scripts[i]);
                gameSource.scripts.push(scriptURL);
                
                loadManager.fetch(scriptURL, 'text', null, function (scriptText) {
                    scriptText = scriptText.replace(/\r/g, '');
                    addCodeToSourceStats(scriptText, scriptURL);
                    fileContents[scriptURL] = scriptText;
                });
            }
        }

        // Modes:
        {
            gameSource.modes = [];
            if (! Array.isArray(gameJSON.modes)) {
                throw new Error('The modes parameter is not an array');
            }

            let numStartModes = 0;
            for (let i = 0; i < gameJSON.modes.length; ++i) {
                const modeURL = makeURLAbsolute(gameURL, gameJSON.modes[i].replace('*', '') + '.pyxl');

                if (gameJSON.modes[i].indexOf('*') !== -1) {
                    ++numStartModes;
                }
                
                gameSource.modes.push({name: gameJSON.modes[i], url:modeURL});
                
                loadManager.fetch(modeURL, 'text', null, function (modeCode) {
                    modeCode = modeCode.replace(/\r/g, '');
                    addCodeToSourceStats(modeCode, modeURL);
                    fileContents[modeURL] = modeCode;
                });
            }

            if (numStartModes === 0) {
                throw new Error('No starting mode (noted with *)');
            } else if (numStartModes > 1) {
                throw new Error('Too many starting modes (noted with *)');
            }
        }

        // Constants:
        gameSource.constants = {};
        if (gameJSON.constants) {
            // Sort constants alphabetically
            const keys = Object.keys(gameJSON.constants);
            keys.sort();
            for (let i = 0; i < keys.length; ++i) {
                const c = keys[i];
                const definition = gameJSON.constants[c];
                if ((definition.type === 'raw') && (definition.url !== undefined)) {
                    // Async
                    const constantURL = makeURLAbsolute(gameURL, definition.url);
                    if (/\.json$/.test(constantURL)) {
                        loadManager.fetch(constantURL, 'json', nullToUndefined, function (data) {
                            gameSource.constants[c] = data;
                        });
                    } else if (/\.yml$/.test(constantURL)) {
                        loadManager.fetch(constantURL, 'text', null, function (yaml) {
                            const json = jsyaml.safeLoad(yaml);
                            gameSource.constants[c] = nullToUndefined(json);
                        });
                    } else {
                        throw 'Unsupported file format for ' + definition.url;
                    }
                } else {
                    // Inline value
                    gameSource.constants[c] = evalJSONGameConstant(definition);
                }
            }
        }
        
        // Assets:
        if (gameJSON.assets) {
            if (typeof gameJSON.assets !== 'object') {
                throw 'The assets parameter is not an object in ' + gameURL;
            }

            gameSource.assets = {};
            
            // Sort assets alphabetically
            const keys = Object.keys(gameJSON.assets);
            keys.sort();
            for (let i = 0; i < keys.length; ++i) {
                const a = keys[i];
                
                // Capture values for the function below
                const assetURL = makeURLAbsolute(gameURL, gameJSON.assets[a]), assetName = a;
                let type = assetURL.match(/\.([^.]+)\.json$/i);
                if (type) { type = type[1].toLowerCase(); }

                loadManager.fetch(assetURL, 'json', null, function (json) {
                    json.url = makeURLAbsolute(assetURL, json.url);
                    
                    fileContents[assetURL] = json;
                    
                    switch (type) {
                    case 'font':
                        gameSource.assets[assetName] = loadFont(assetName, json, assetURL);
                        break;
                        
                    case 'sprite':
                        gameSource.assets[assetName] = loadSpritesheet(assetName, json, assetURL, null);
                        break;
                        
                    case 'sound':
                        gameSource.assets[assetName] = loadSound(assetName, json, assetURL);
                        break;
                        
                    case 'map':
                        gameSource.assets[assetName] = loadMap(assetName, json, assetURL);
                        break;
                        
                    default:
                        console.log('Unrecognized asset type: "' + type + '"');
                    }

                });
                
                
            } // for each asset
        }

    }, loadFailureCallback, loadWarningCallback);

    loadManager.end();
}


/** Computes gameSource.constants.assetCredits from gameSource */
function computeAssetCredits(gameSource) {
    function canonicalizeLicense(license) {
        // Remove space after copyright and always just use the symbol
        license = license.replace(/(?:\(c\)|copyright|©)\s*(?=\d)/gi, '©');
        
        // Lower-case any leading "by"
        license = license.replace(/^By /, 'by');
        return license;
    }

    const assetCredits = gameSource.constants.assetCredits = {
        game: [],
        pack: [],
        font: [],
        sprite: [],
        sound: [],
        code: []
    };

    // Game
    assetCredits.game.push((gameSource.json.title || 'Untitled') + (gameSource.json.developer ? ' by ' +
                                                    gameSource.json.developer : '') + ' ' +
                           (gameSource.json.copyright || ''));
    if (gameSource.json.license) { assetCredits.game.push(canonicalizeLicense(gameSource.json.license)); }
    
    assetCredits.title = gameSource.json.title || 'Untitled';
    assetCredits.developer = gameSource.json.developer || '';

    // Map from canonicalized licenses to assets that use them
    const cache = {};
    for (let type in assetCredits) {
        cache[type] = new Map();
    }
    Object.seal(cache);

    function addCredit(type, assetURL, license) {
        license = canonicalizeLicense(license);
        if (! cache[type].has(license)) {
            cache[type].set(license, []);
        }
        cache[type].get(license).push(urlFile(assetURL).replace(/\.[^\.]+\.json$/, ''));
    }
    
    for (let a in gameSource.assets) {
        const asset = gameSource.assets[a];
        const json = asset._json;
        
        let type = asset._jsonURL.match(/\.([^.]+)\.json$/i);
        if (type) { type = type[1].toLowerCase(); }

        if (json.license && assetCredits[type]) {
            addCredit(type, asset._jsonURL, json.license);
        }

        if (type === 'map') {
            // Process the spritesheets
            for (let k in asset.spritesheetTable) {
                const spritesheet = asset.spritesheetTable[k];
                const json = spritesheet._json;
                if (json.license) {
                    addCredit('sprite', spritesheet._jsonURL, json.license);
                }
            }
        }
    }

    // Generate the credits from the cache, consolidating those with the same license.
    for (let type in cache) {
        cache[type].forEach(function (assetList, license) {
            let assets;
            if (assetList.length === 1) {
                assets = assetList[0];
            } else if (assetList.length === 2) {
                assets = assetList[0] + ' and ' + assetList[1];
            } else {
                assets = assetList.slice(0, assetList.length - 1).join(', ') + ', and ' + assetList[assetList.length - 1];
            }            
            assetCredits[type].push(assets + ' ' + license);
        });
    }
    
    // The quadplay runtime. We only need to credit code that is in the runtime, not the compiler or IDE.
    assetCredits.code.push('gif.js ©2013 Johan Nordberg, used under the MIT license, with additional programming by Kevin Weiner, Thibault Imbert, and Anthony Dekker');
    assetCredits.code.push('xorshift implementation ©2014 Andreas Madsen and Emil Bay, used under the MIT license');
    assetCredits.code.push('LoadManager.js ©2019 Morgan McGuire, used under the BSD license');
    assetCredits.code.push('js-yaml ©2011-2015 Vitaly Puzrin, used under the MIT license');
    assetCredits.code.push('quadplay✜ ©2019 Morgan McGuire, used under the LGPL 3.0 license');
}


function loadFont(name, json, jsonURL) {
    const font = {
        _name:     name,
        _url:      json.url,
        _json:     json,
        _jsonURL:  jsonURL
    };
    
    onLoadFileStart(json.url);
    loadManager.fetch(json.url, 'image', getBinaryImageData, function (srcMask, image, url) {
        onLoadFileComplete(json.url);

        // Save the raw image for the IDE
        fileContents[url] = image;
        
        const borderSize = 1;
        const shadowSize = parseInt(json.shadowSize || 1);

        packFont(font, borderSize, shadowSize, json.baseline, json.charSize, Object.freeze({x: json.letterSpacing.x, y: json.letterSpacing.y}), srcMask);
        
        resourceStats.spritePixels += font._data.width * font._data.height;
        ++resourceStats.spritesheets;
        resourceStats.maxSpritesheetWidth  = Math.max(resourceStats.maxSpritesheetWidth,  font._data.width);
        resourceStats.maxSpritesheetHeight = Math.max(resourceStats.maxSpritesheetHeight, font._data.height);
        
        Object.freeze(font);
    }, loadFailureCallback, loadWarningCallback);
    
    return font;
}

/** Extracts the image data and returns two RGBA4 arrays as [Uint32Array, Uint32Array],
    where the second is flipped horizontally */
function getImageData4BitAndFlip(image) {
    const data = getImageData4Bit(image);
    const flipped = new Uint32Array(data.length);
    flipped.width = data.width;
    flipped.height = data.height;

    for (let y = 0; y < data.height; ++y) {
        for (let x = 0; x < data.width; ++x) {
            const i = x + y * data.width;
            const j = (data.width - 1 - x) + y * data.width;
            flipped[i] = data[j];
        }
    }
    
    return [data, flipped];
}


/** Extracts the image data from an Image and quantizes it to RGBA4
 * format, returning a Uint32Array */
function getImageData4Bit(image) {
    // Make a uint32 aliased version
    const data = new Uint32Array(getImageData(image).data.buffer);
    data.width = image.width;
    data.height = image.height;
    
    // Quantize (more efficient to process four bytes at once!)
    // Converts R8G8B8A8 to R4G4B4A4-equivalent by copying high bits to low bits.
    const N = data.length;
            
    for (let i = 0; i < N; ++i) {
        // Debug endianness
        //console.log('0x' + a[i].toString(16) + ' : [0]=' + spritesheet.data[4*i] + ', [1] = '+ spritesheet.data[4*i+1] + ', [2] = '+ spritesheet.data[4*i+2] + ', [3] = '+ spritesheet.data[4*i+3]);
        const c = (data[i] >> 4) & 0x0F0F0F0F;
        data[i] = (c << 4) | c;
    }

    return data;
}


/** url must be an absolute URL */
function loadSpritesheet(name, json, jsonURL, callback, noForce) {
    // These fields have underscores so that they can't be accessed from nanoscript.
    const spritesheet = Object.assign([], {
        _name: name,
        _uint32data: null,
        _uint32dataFlippedX : null,
        _url: json.url,
        _gutter: (json.spriteSize.gutter || 0),
        _json: json,
        _jsonURL: jsonURL,
        spriteSize: Object.freeze({x: json.spriteSize.x, y: json.spriteSize.y})
    });

    // Offsets used for scale flipping
    const PP = Object.freeze({x: 1, y: 1});
    const NP = Object.freeze({x:-1, y: 1});
    const PN = Object.freeze({x: 1, y:-1});
    const NN = Object.freeze({x:-1, y:-1});
          
    // Actually load the image
    const oldForce = loadManager.forceReload;
    if (noForce) { loadManager.forceReload = false; }
    onLoadFileStart(json.url);
    loadManager.fetch(json.url, 'image', getImageData4BitAndFlip, function (dataPair, image, url) {
        onLoadFileComplete(json.url);
        const data = dataPair[0];

        if (! (url in fileContents)) {
            // This image has not been previously loaded by this project
            fileContents[url] = image;
            resourceStats.spritePixels += data.width * data.height;
            ++resourceStats.spritesheets;
            resourceStats.maxSpritesheetWidth = Math.max(resourceStats.maxSpritesheetWidth, data.width);
            resourceStats.maxSpritesheetHeight = Math.max(resourceStats.maxSpritesheetHeight, data.height);
        }
        
        spritesheet._uint32Data = data;
        spritesheet._uint32DataFlippedX = dataPair[1];
        
        const boundingRadius = Math.hypot(spritesheet.spriteSize.x, spritesheet.spriteSize.y);
        spritesheet.size = {x: data.width, y: data.height};
        
        // Create the default grid mapping
        let rows = Math.floor((data.height + spritesheet._gutter) / (spritesheet.spriteSize.y + spritesheet._gutter));
        let cols = Math.floor((data.width  + spritesheet._gutter) / (spritesheet.spriteSize.x + spritesheet._gutter));
        
        if (json.transpose) { let temp = rows; rows = cols; cols = temp; }
        
        for (let x = 0; x < cols; ++x) {
            spritesheet[x] = [];           
            
            for (let y = 0; y < rows; ++y) {
                const u = json.transpose ? y : x, v = json.transpose ? x : y;
                
                // Check for alpha channel
                let hasAlpha = false;
                outerloop:
                for (let j = 0; j < spritesheet.spriteSize.y; ++j) {
                    let index = (y * (spritesheet.spriteSize.y + spritesheet._gutter) + j) * data.width + x * (spritesheet.spriteSize.x + spritesheet._gutter);
                    for (let i = 0; i < spritesheet.spriteSize.x; ++i, ++index) {
                        if (data[index] >>> 24 < 0xff) {
                            hasAlpha = true;
                            break outerloop;
                        }
                    }
                }

                // Create the actual sprite
                const sprite = {
                    _tileX: u,
                    _tileY: v,
                    _boundingRadius: boundingRadius,
                    _x: u * (spritesheet.spriteSize.x + spritesheet._gutter),
                    _y: v * (spritesheet.spriteSize.y + spritesheet._gutter),
                    _hasAlpha: hasAlpha,
                    spritesheet: spritesheet,
                    tileIndex: Object.freeze({x:u, y:v}),
                    id:++lastSpriteID,
                    size: spritesheet.spriteSize,
                    scale: PP
                };

                // Construct the flipped versions
                sprite.flippedX = Object.assign({flippedX:sprite}, sprite);
                sprite.flippedX.scale = NP;
                sprite.flippedX.lastSpriteID = ++lastSpriteID;

                sprite.flippedY = Object.assign({flippedY:sprite}, sprite);
                sprite.flippedY.lastSpriteID = ++lastSpriteID;
                sprite.flippedY.scale = PN;

                sprite.flippedX.flippedY = sprite.flippedY.flippedX = Object.assign({}, sprite);
                sprite.flippedY.flippedX.scale = NN;
                sprite.flippedY.flippedX.lastSpriteID = ++lastSpriteID;

                // Fresze all versions
                Object.freeze(sprite.flippedX);
                Object.freeze(sprite.flippedY);
                Object.freeze(sprite.flippedY.flippedX);
                spritesheet[x][y] = Object.freeze(sprite);
            }
            
            Object.freeze(spritesheet[x]);
        }

        // Process the name table
        if (json.names) {
            if (Array.isArray(json.names) || (typeof json.names !== 'object')) {
                throw new Error('The "names" entry in a sprite.json file must be an object (was "' + (typeof json.names) + '")');
            }

            for (let anim in json.names) {
                let data = json.names[anim];
                
                // Error checking
                if ((data.start !== undefined && data.x !== undefined) || (data.start === undefined && data.x === undefined)) {
                    throw new Error('Animation data for "' + anim + '" must have either "x" and "y" fields or a "start" field, but not both');
                }
                
                // Apply defaults
                if (data.x !== undefined) { data = {start: data, extrapolate: 'clamp'}; }
                
                if (data.end === undefined) { data.end = Object.assign({}, data.start); }

                if (data.end.x === undefined) { data.end.x = data.start.x; }
                
                if (data.end.y === undefined) { data.end.y = data.start.y; }

                if (data.start.x !== data.end.x && data.start.y !== data.end.y) {
                    throw new Error('Animation frames must be in a horizontal or vertical line for animation "' + anim + '"');
                }

                spritesheet[anim] = [];
                spritesheet[anim].extrapolate = data.extrapolate || 'loop';

                for (let y = data.start.y; y <= data.end.y; ++y) {
                    for (let x = data.start.x; x <= data.end.x; ++x) {
                        const u = json.transpose ? y : x, v = json.transpose ? x : y;
                        if (u < 0 || u >= spritesheet.length || v < 0 || v >= spritesheet[0].length) {
                            throw new Error('Index xy(' + u + ', ' + v + ') in animation "' + anim + '" is out of bounds.');
                        }
                        
                        spritesheet[anim].push(spritesheet[u][v]);
                    }
                }

                Object.freeze(spritesheet[anim]);
            }
        }

        // Prevent the game from modifying this asset
        Object.freeze(spritesheet);

        if (callback) { callback(spritesheet); }
    }, loadFailureCallback, loadWarningCallback);
    
    if (noForce) { loadManager.forceReload = oldForce; }
    
    return spritesheet;
}
    

// Use only MP3s
function loadSound(name, json, jsonURL) {
    ++resourceStats.sounds;
    let sound = Object.seal({ src: json.url,
                              name: name,
                              loaded: false, 
                              source: null,
                              buffer: null,
                              playing: false,
                              _json: json,
                              _jsonURL: jsonURL});
    
    fileContents[json.url] = sound;
    onLoadFileStart(json.url);
    loadManager.fetch(json.url, 'arraybuffer', null, function (arraybuffer) {
        // LoadManager can't see the async decodeAudioData calls
        ++loadManager.pendingRequests;

        try {
            _ch_audioContext.decodeAudioData(
                // The need for slice is some Chrome multithreading issue
                // https://github.com/WebAudio/web-audio-api/issues/1175
                arraybuffer.slice(0), 
                function onSuccess(buffer) {
                    sound.buffer = buffer;
                    sound.loaded = true;
                    
                    // Create a buffer, which primes this sound for playing
                    // without delay later.
                    sound.source = _ch_audioContext.createBufferSource();
                    sound.source.buffer = sound.buffer;
                    //sound.source.connect(_ch_audioContext.gainNode);
                    onLoadFileComplete(json.url);
                    loadManager.markRequestCompleted(json.url, '', true);
                }, 
                function onFailure() {
                    loadManager.markRequestCompleted(json.url, 'unknown error', false);
                });
        } catch (e) {
            loadManager.markRequestCompleted(json.url, e, false);
        }
    }, loadFailureCallback, loadWarningCallback);
    
    return sound;
}


function loadMap(name, json, mapJSONUrl) {
    const map = Object.assign([], {
        _name:   name,
        _url: json.url,
        _offset: json.offset ? {x:json.offset.x, y:json.offset.y} : {x:0, y:0},
        _flipYOnLoad: json.flipY || false,
        _json: json,
        _jsonURL: mapJSONUrl,
        zOffset: json.zOffset || 0,
        zScale: (json.zScale || 1),
        layer:  [],
        spritesheetTable:Object.create(null),
        spriteSize: Object.freeze({x:0, y:0}),
        wrapX: json.wrapX || false,
        wrapY: json.wrapY || false,
    });

    if (json.spriteUrl) {
        json.spriteUrlTable = {'<default>': json.spriteUrl};
    } else if (! json.spriteUrlTable) {
        throw 'No spriteUrlTable specified';
    }

    const key = Object.keys(json.spriteUrlTable)[0];
    const spritesheetUrl = makeURLAbsolute(mapJSONUrl, json.spriteUrlTable[key]);

    onLoadFileStart(spritesheetUrl);
    loadManager.fetch(spritesheetUrl, 'json', null, function (spritesheetJson) {
        onLoadFileComplete(spritesheetUrl);
        spritesheetJson.url = makeURLAbsolute(spritesheetUrl, spritesheetJson.url);

        const spritesheet = loadSpritesheet(null, spritesheetJson, spritesheetUrl, function (spritesheet) {
            loadManager.fetch(makeURLAbsolute(mapJSONUrl, json.url), 'text', null, function (xml) {
                onLoadFileComplete(json.url);
                xml = new DOMParser().parseFromString(xml, "application/xml");
        
                let tileSet = xml.getElementsByTagName('tileset');
                tileSet = tileSet[0];
                map.spriteSize = Object.freeze({x: parseInt(tileSet.getAttribute('tilewidth')),
                                                y: parseInt(tileSet.getAttribute('tileheight'))});
                const columns = parseInt(tileSet.getAttribute('columns'));
                const spritesheetName = tileSet.getAttribute('name');

                if ((Object.keys(json.spriteUrlTable)[0] !== '<default>') &&
                    (Object.keys(json.spriteUrlTable)[0] !== spritesheetName)) {
                    throw 'Spritesheet name "' + spritesheetName + '" in ' + spritesheetUrl + ' does not match the name from the map file ' + mapJSONUrl;
                }
                
                map.spritesheetTable[spritesheetName] = spritesheet;

                let image = xml.getElementsByTagName('image')[0];
                const size = {x: parseInt(image.getAttribute('width')),
                              y: parseInt(image.getAttribute('height'))};
                const filename = image.getAttribute('source');

                if ((spritesheet.spriteSize.x !== map.spriteSize.x) || (spritesheet.spriteSize.y !== map.spriteSize.y)) {
                    throw `Sprite size (${spritesheet.spriteSize.x}, ${spritesheet.spriteSize.y}) does not match what the map expected, (${map.spriteSize.x}, ${map.spriteSize.y}).`;
                }

                if ((spritesheet.size.x !== size.x) || (spritesheet.size.y !== size.y)) {
                    throw `Sprite sheet size (${spritesheet.size.x}, ${spritesheet.size.y}) does not match what the map expected, (${size.x}, ${size.y}).`;
                }
                
                let layerList = Array.from(xml.getElementsByTagName('layer'));
                const layerData = layerList.map(function (layer) {
                    map.size = Object.freeze({x: parseInt(layer.getAttribute('width')),
                                              y: parseInt(layer.getAttribute('height'))});
                    // Can't directly pass parseInt for some reason
                    return layer.lastElementChild.innerHTML.split(',').map(function (m) { return parseInt(m); });
                });
                
                const flipY = (json.flipY === true);
                
                for (let L = 0; L < layerList.length; ++L) {
                    // The first level IS the map itself
                    const layer = (L === 0) ? map : new Array(map.size.x);
                    const data = layerData[L];
                    
                    // Construct the layer
                    for (let x = 0; x < map.size.x; ++x) { layer[x] = new Array(map.size.y); }
                    map.layer.push(layer);
                    
                    // Extract CSV values
                    for (let y = 0, i = 0; y < map.size.y; ++y) {
                        for (let x = 0; x < map.size.x; ++x, ++i) {
                            const gid = data[i];

                            // See https://doc.mapeditor.org/en/stable/reference/tmx-map-format/#layer
                            const tileFlipX = (gid & 0x80000000) !== 0;
                            const tileFlipY = (gid & 0x40000000) !== 0;
                            const tmxIndex  = (gid & 0x0fffffff) - 1;
                            
                            if (tmxIndex >= 0) {
                                const sx = tmxIndex % columns;
                                const sy = Math.floor(tmxIndex / columns);

                                let sprite = spritesheet[sx][sy];

                                if (tileFlipX) { sprite = sprite.flippedX; }

                                if (tileFlipY) { sprite = sprite.flippedY; }
                                
                                layer[x][flipY ? map.size.y - 1 - y : y] = sprite;
                            } else {
                                layer[x][flipY ? map.size.y - 1 - y : y] = undefined;
                            } // if not empty
                        } // x
                    } // y
                    
                    // Prevent the arrays themselves from being reassigned
                    for (let x = 0; x < map.size.x; ++x) {
                        Object.seal(layer[x]);
                    }
                } // L
                
                // Don't allow the array of arrays to be changed (just the individual elements)
                Object.seal(map.layer);
            }, loadFailureCallback, loadWarningCallback);
        });
    });
    
    return map;
}


/** Maps URLs to their raw contents for use in displaying them in the IDE */
let fileContents = {};
let resourceStats = {};

function modeNameToFileName(modeName) {
    return modeName.replace(/\*/, '') + '.pyxl';
}


/* 
   Takes an already-loaded image and creates an ImageData for it.

   JavaScript imageData colors on a little endian machine:

   - In hex as a uint32, the format is 0xAABBGGRR.
   - Aliased to a Uint8Clamped array, im = [RR, GG, BB, AA]
*/
function getImageData(image) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = image.width;
    tempCanvas.height = image.height;
    
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(image, 0, 0, image.width, image.height);
    
    return tempCtx.getImageData(0, 0, image.width, image.height);
}


function addCodeToSourceStats(code, scriptURL) {
    // Remove strings
    code = code.replace(/"(?:[^"\\]|\\.)*"/g, '');

    // Remove comments
    code = code.replace(/\/\*([\s\S]*?)\*\//g, '');
    code = code.replace(/\/\/.*$/gm, '');

    // Compact literals
    const lineArray = code.split('\n');
    try {
        compactMultilineLiterals(lineArray);
    } catch (e) {
        // Error occured during compaction of multiline literals
        e.url = scriptURL;
        console.log(e);
    }
    code = lineArray.join('\n');

    // Remove section headers
    const sectionRegex = /(?:^|\n)[ \t]*(init|enter|frame|leave)[ \t]*\n(?:-|─|—|━|⎯){5,}[ \t]*\n/;
    code = code.replace(sectionRegex, '\n');

    // Remove blank lines
    code = code.replace(/\n\s*\n/g, '\n');

    resourceStats.sourceStatements += Math.max(0, (code.split(';').length - 1) + (code.split('\n').length - 1) - 1);
}


function loadFailureCallback(reason, url) {
    console.log(`ERROR: Failed to load "${url}". ${reason || ''}`);
}


function loadWarningCallback(reason, url) {
    _outputAppend(url + ': ' + reason + '\n');
}


/** Returns everything up to the final slash from a URL */
function urlDir(url) {
    return url.replace(/\?.*$/, '').replace(/\/[^/]*$/, '/');
}

function urlFile(url) {
    return url.substring(url.lastIndexOf('/') + 1);
}

/** Returns the childURL made absolute relative to the parent */
function makeURLAbsolute(parentURL, childURL) {
    if (/^(?:nano|quad):\/\//.test(childURL)) {
        // quad URL. Make relative to the quadplay installation
        return childURL.replace(/^(?:nano|quad):\/\//, urlDir(location.href) + '../');
    } else if (/^.{3,6}:\/\//.test(childURL)) {
        // Already absolute, some other protocol
        return childURL;
    } else {
        // Strip the last part of the parent
        return urlDir(parentURL) + childURL;
    }
}


/** Returns the filename portion of the URL */
function urlFilename(url) {
    return url.replace(/^.*\//, '');
}


/** Recursively replaces null with undefined, mutating any structures and returning the result. */
function nullToUndefined(x) {
    if (x === null) {
        x = undefined;
    } else if (Array.isArray(x)) {
        for (let i = 0; i < x.length; ++i) {
            x[i] = nullToUndefined(x[i]);
        }
    } else if (typeof x === 'object') {
        const keys = Object.keys(x);
        for (let k = 0; k < keys.length; ++k) {
            const key = keys[k];
            x[key] = nullToUndefined(x[key]);
        }
    }
    return x;
}


function regexIndexOf(text, re, i) {
    const indexInSuffix = text.substring(i).search(re);
    return indexInSuffix < 0 ? text.length : indexInSuffix + i;
}


/** Also used by the runtime */
function _parse(source, i) {
    i = i || 0;
    if (typeof source !== 'string') {
        throw new Error('parse() requires a string as an agument');
    }
    
    while (i < source.length) {
        switch (source[i]) {
        case ' ': case '\t': case '\n':
            // Nothing to do
            ++i;
            break;
            
        case '"': // Quoted string
            ++i;
            const begin = i;
            while (i < source.length && (source[i] !== '"' || source[i - 1] === '\\')) { ++i; }
            return {result: source.substring(begin, i), next: i + 1};
            
        case '[': // Array
            ++i;
            // Consume the leading space
            while (' \t\n'.indexOf(source[i]) !== -1) { ++i; }
            const a = [];
            while ((i < source.length) && (source[i] !== ']')) {                
                const child = _parse(source, i);

                if (child.result === '…') {
                    // This is a recursive array
                    while (i < source.length && source[i] !== ']') { ++i; }
                    return {result: [], next: i + 1};
                }

                a.push(child.result);
                i = child.next;
                // Consume the trailing space and comma. For simplicity, don't require
                // correct structure in the source here.
                while (', \t\n'.indexOf(source[i]) !== -1) { ++i; }
            }
            // consume the ']'
            return {result: a, next: i + 1}
            break;
            
        case '{': // Table
            ++i;
            const t = {};
            // Consume the leading space
            while (' \t\n'.indexOf(source[i]) !== -1) { ++i; }
            while ((i < source.length) && (source[i] !== '}')) {
                // Read the key
                let key;
                if (source[i] === '"') {
                    // The key is in quotes
                    const temp = _parse(source, i);
                    key = temp.result;
                    i = temp.next;
                } else {
                    // Scan until the next separator
                    const end = regexIndexOf(source, /[: \n\t"]/, i);
                    key = source.substring(i, end);
                    i = end;
                }

                if (key === '…') {
                    // This is a recursive empty table
                    while (i < source.length && source[i] !== '}') { ++i; }
                    return {result: {}, next: i + 1};
                }

                // Consume the colon and space
                while (': \t\n'.indexOf(source[i]) !== -1) { ++i; }

                // Read the value
                const value = _parse(source, i);
                t[key] = value.result;
                i = value.next;
                // Consume the trailing space and comma
                while (', \t\n'.indexOf(source[i]) !== -1) { ++i; }
            }
            // consume the ']'
            return {result: t, next: i + 1}
            break;
            
        default: // a constant
            // Scan until the next separator
            const end = regexIndexOf(source, /[,:\[{}\] \n\t"]/, i);
            const token = source.substring(i, end).toLowerCase();
            switch (token) {
            case 'true': return {result: true, next: end + 1};
            case 'false': return {result: false, next: end + 1};
            case 'nil': case '∅': case 'builtin': return {result: undefined, next: end + 1};
            case 'function': return {result: (function () {}), next: end + 1};
            case 'infinity': case '∞': case '+infinity': case '+∞': return {result: Infinity, next: end + 1};
            case '-infinity': case '-∞': return {result: -Infinity, next: end + 1};
            case 'nan': return {result: NaN, next: end + 1};
            case 'π': return {result: Math.pi, next: end + 1};
            case '-π': return {result: -Math.pi, next: end + 1};
            case '¼': return {result: 1/4, next: end + 1};
            case '½': return {result: 1/2, next: end + 1};
            case '¾': return {result: 3/4, next: end + 1};
            case '⅓': return {result: 1/3, next: end + 1};
            case '⅔': return {result: 2/3, next: end + 1};
            case '⅕': return {result: 1/5, next: end + 1};
            case '⅖': return {result: 2/5, next: end + 1};
            case '⅗': return {result: 3/5, next: end + 1};
            case '⅘': return {result: 4/5, next: end + 1};
            case '⅙': return {result: 1/6, next: end + 1};
            case '⅚': return {result: 5/6, next: end + 1};
            case '⅐': return {result: 1/7, next: end + 1};
            case '⅛': return {result: 1/8, next: end + 1};
            case '⅜': return {result: 3/8, next: end + 1};
            case '⅝': return {result: 5/8, next: end + 1};
            case '⅞': return {result: 7/8, next: end + 1};
            case '⅑': return {result: 1/9, next: end + 1};
            case '⅒': return {result: 1/10, next: end + 1};
            case '-¼': return {result: -1/4, next: end + 1};
            case '-½': return {result: -1/2, next: end + 1};
            case '-¾': return {result: -3/4, next: end + 1};
            case '-⅓': return {result: -1/3, next: end + 1};
            case '-⅔': return {result: -2/3, next: end + 1};
            case '-⅕': return {result: -1/5, next: end + 1};
            case '-⅖': return {result: -2/5, next: end + 1};
            case '-⅗': return {result: -3/5, next: end + 1};
            case '-⅘': return {result: -4/5, next: end + 1};
            case '-⅙': return {result: -1/6, next: end + 1};
            case '-⅚': return {result: -5/6, next: end + 1};
            case '-⅐': return {result: -1/7, next: end + 1};
            case '-⅛': return {result: -1/8, next: end + 1};
            case '-⅜': return {result: -3/8, next: end + 1};
            case '-⅝': return {result: -5/8, next: end + 1};
            case '-⅞': return {result: -7/8, next: end + 1};
            case '-⅑': return {result: -1/9, next: end + 1};
            case '-⅒': return {result: -1/10, next: end + 1};
            default:
                if (/(deg|°)$/.test(token)) {
                    return {result: parseFloat(token) * Math.PI / 180, next: end + 1};
                } else if (/%$/.test(token)) {
                    return {result: parseFloat(token) / 100, next: end + 1};
                } else {
                    return {result: parseFloat(token), next: end + 1};
                }
            } // switch on token
        } // switch on character
    } // while

    throw new Error('hit the end of ' + source);
}


/** Evaluate a constant value from JSON. Used only while loading. */
function evalJSONGameConstant(json) {
    switch (json.type) {
    case 'nil':
        return undefined;
        
    case 'raw':
        if (json.url !== undefined) {
            throw 'Raw values with URLs only permitted for top-level constants';
        }
        
        // Replace null with undefined, but otherwise directly read the value
        return nullToUndefined(json.value);
        
    case 'number':
        if (typeof json.value === 'number') {
            return json.value;
        } else {
            return _parse(json.value.trim()).result;
        }
        break;
        
    case 'boolean': return (json.value === true) || (json.value === 'true');

    case 'string': return json.value;

    case 'xy':
        return {x: evalJSONGameConstant(json.value.x),
                y: evalJSONGameConstant(json.value.y)};

    case 'xyz':
        return {x: evalJSONGameConstant(json.value.x),
                y: evalJSONGameConstant(json.value.y),
                z: evalJSONGameConstant(json.value.z)};

    case 'rgb':
        if (typeof json.value === 'object') {
            return {r: evalJSONGameConstant(json.value.r),
                    g: evalJSONGameConstant(json.value.g),
                    b: evalJSONGameConstant(json.value.b)};
        } else if ((typeof json.value === 'string') && (json.value[0] === '#')) {
            // Parse color
            const c = parseHexColor(json.value.substring(1));
            return {r: c.r, g: c.g, b: c.b};
        } else {
            throw 'Illegal rgb value: ' + json.value;
        }

    case 'rgba':
        if (typeof json.value === 'object') {
            return {r: evalJSONGameConstant(json.value.r),
                    g: evalJSONGameConstant(json.value.g),
                    b: evalJSONGameConstant(json.value.b),
                    a: evalJSONGameConstant(json.value.a)};
        } else if (typeof json.value === 'string' && json.value[0] === '#') {
            // Parse color
            return parseHexColor(json.value.substring(1));
        } else {
            throw 'Illegal rgba value: ' + json.value;
        }

    case 'grid':
        // TODO
        console.error('Not implemented');

    case 'object':
        // TODO
        console.error('Not implemented');

    case 'array':
        // TODO
        console.error('Not implemented');

    default:
        throw 'Unrecognized data type: "' + json.type + '"';
    }
}
