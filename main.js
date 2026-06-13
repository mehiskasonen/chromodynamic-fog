/* ============================================================================
 * Chromodynamic Fog — per-player line of sight for Owlbear Rodeo
 * ----------------------------------------------------------------------------
 * CORE IDEA
 *   Owlbear Rodeo's built-in Dynamic Fog system is driven by two item kinds:
 *
 *     - WALLS  -> opaque geometry that blocks vision
 *     - LIGHTS -> vision sources that "reveal" through the fog
 *
 *   By default, items live in the SHARED scene (OBR.scene.items), meaning
 *   every connected player receives them and the fog reveals merge into a
 *   single party-wide view.
 *
 *   This extension instead writes vision LIGHTS to the LOCAL scene
 *   (OBR.scene.local). Local items are never broadcast to other clients;
 *   they exist only in the current browser tab. As a result:
 *
 *     - Player A's lights reveal fog ONLY on Player A's monitor.
 *     - Player B never receives those light items, so their fog stays dark
 *       wherever Player B's own tokens cannot see.
 *
 *   Walls can stay in the shared scene so every client agrees on the same
 *   collision geometry (otherwise players would disagree about what blocks
 *   vision and chaos ensues). Only the vision-sources are isolated.
 *
 * OWNERSHIP MODEL
 *   OBR does not have a first-class "this token belongs to player X" field,
 *   so this extension stores ownership in item.metadata under our namespace:
 *
 *     item.metadata["com.example.chromofog/ownerId"] = "<player-uuid>"
 *
 *   A token is considered owned by the current player when ANY of:
 *     (a) the metadata flag above matches their player ID, or
 *     (b) the token was placed by the current player (createdUserId match),
 *         which is the natural case when players drag their own minis in.
 *
 *   GMs see vision from every token by default (toggleable below).
 * ========================================================================== */

import OBR, {
    buildLight,
    isImage, // tokens in OBR are typically Image items on the CHARACTER layer
    isLight,
} from "https://esm.sh/@owlbear-rodeo/sdk@3";

/* ----- Configuration -------------------------------------------------------*/

const EXTENSION_ID = "com.example.chromofog";
const OWNER_META_KEY = `${EXTENSION_ID}/ownerId`;
const LIGHT_TAG_KEY = `${EXTENSION_ID}/lightFor`; // marks lights we own
const DEFAULT_VISION_GRID_SQUARES = 8;            // ~40 ft on a 5-ft grid
const GM_SEES_ALL = false;                         // GMs reveal from all tokens

/* ----- Runtime state (LOCAL to this browser tab only) ---------------------*/

let myPlayerId = null;       // OBR.player.getId() result for THIS client
let myRole = "PLAYER";       // "GM" or "PLAYER"
let gridDpi = 150;           // pixels per grid square, cached from OBR.scene.grid
let visionRadiusPx = 0;      // computed from grid dpi * DEFAULT_VISION_GRID_SQUARES

/* ----- Bootstrapping -------------------------------------------------------*/

OBR.onReady(async () => {
    // 1. Identify *this* client. Every player's iframe resolves a different ID
    //    here, which is the seed of the whole isolation scheme.
    myPlayerId = await OBR.player.getId();
    myRole = await OBR.player.getRole();

    // 2. Vision math is grid-relative, so we need the scene's DPI.
    //    We wait for the scene to be ready before reading it.
    if (await OBR.scene.isReady()) {
        await initSceneState();
    }

    // 3. If the user changes scene (new map), re-init from scratch.
    OBR.scene.onReadyChange(async (ready) => {
        await clearAllLocalLights();
        if (ready) await initSceneState();
    });
});

async function initSceneState() {
    gridDpi = await OBR.scene.grid.getDpi();
    visionRadiusPx = gridDpi * DEFAULT_VISION_GRID_SQUARES;

    // Initial pass: build vision for every token we currently own.
    const items = await OBR.scene.items.getItems();
    await reconcileLights(items);

    // Subscribe to live changes. The callback fires for ANY scene mutation —
    // tokens moving, being added, deleted, metadata edits, etc. Because the
    // subscription is established inside this client's iframe, it only sees
    // the shared scene state; nothing here ever touches another player's
    // local items.
    OBR.scene.items.onChange(async (allItems) => {
        await reconcileLights(allItems);
    });
}

/* ----- Ownership predicate -------------------------------------------------*/

/**
 * Decide whether the current player should have a vision source attached
 * to the given item. This is the *only* place we filter by player ID, and
 * it runs against the SHARED items list — the result then drives what we
 * write into the LOCAL scene.
 */
function isOwnedByMe(item) {
    // Must be a token-like thing. Filter aggressively to avoid attaching
    // lights to maps, props, walls, drawings, etc.
    if (!isImage(item)) return false;
    if (item.layer !== "CHARACTER") return false;

    // GM override — GMs can be allowed to see through every token.
    if (GM_SEES_ALL && myRole === "GM") return true;

    // Explicit ownership tag set via context menu / character-sheet extension.
    const taggedOwner = item.metadata?.[OWNER_META_KEY];
    if (taggedOwner && taggedOwner === myPlayerId) return true;

    // Fallback: the token was dropped onto the map by this player.
    if (item.createdUserId === myPlayerId) return true;

    return false;
}

/* ----- Light reconciliation -----------------------------------------------*/

// Per-token state: lightId we created locally, plus a hash of the parameters
// we built it with. The hash lets us skip work when nothing actually changed
// (token movement is handled automatically by attachedTo and shouldn't cause
// a rebuild).
const tokenToLight = new Map();   // tokenId -> { lightId, paramsHash }

/**
 * Find the OBR Light item (from Dynamic Fog or any other source) that's
 * attached to the given token. Dynamic Fog v1.1 creates exactly one Light
 * per "Add Light" action, so a single .find() is enough.
 */
function findAttachedLight(allItems, tokenId) {
    return allItems.find(it => isLight(it) && it.attachedTo === tokenId);
}

/**
 * Extract the visual parameters from a shared Light item. These are the
 * exact knobs the Dynamic Fog "Light Settings" panel manipulates.
 * Any property that's undefined on the source light is left out so the
 * builder uses the SDK default.
 */
function extractParams(light) {
    return {
        attenuationRadius: light.attenuationRadius,
        sourceRadius:      light.sourceRadius,
        falloff:           light.falloff,
        innerAngle:        light.innerAngle,
        outerAngle:        light.outerAngle,
        lightType:         light.lightType,
    };
}

/**
 * Used when a token has no Dynamic Fog light attached. Keeps the extension
 * functional even if you forget to add a light via Dynamic Fog's UI.
 */
function defaultParams() {
    return {
        attenuationRadius: visionRadiusPx,
        sourceRadius:      gridDpi * 0.5,
        falloff:           1,
    };
}

/**
 * Build a local OBR Light from a params object. Properties not present in
 * the params (e.g. innerAngle on a full-circle light) are simply omitted,
 * leaving the SDK to apply defaults.
 */
function buildLocalLight(token, params) {
    const b = buildLight()
        .position(token.position)
        .attachedTo(token.id)
        .metadata({ [LIGHT_TAG_KEY]: token.id })
        .disableAttachmentBehavior(["ROTATION"]);

    if (typeof params.attenuationRadius === "number") b.attenuationRadius(params.attenuationRadius);
    if (typeof params.sourceRadius      === "number") b.sourceRadius(params.sourceRadius);
    if (typeof params.falloff           === "number") b.falloff(params.falloff);
    if (typeof params.innerAngle        === "number") b.innerAngle(params.innerAngle);
    if (typeof params.outerAngle        === "number") b.outerAngle(params.outerAngle);
    if (params.lightType)                              b.lightType(params.lightType);

    return b.build();
}

/**
 * Cheap stable hash so we can detect parameter changes between onChange ticks
 * without diffing every field by hand.
 */
function paramsHash(p) {
    return JSON.stringify(p);
}

/**
 * Reconcile local vision lights against the current shared scene state.
 * Runs on every onChange. Position updates require no work (attachedTo
 * handles that). We only delete + recreate when ownership or visual params
 * change.
 */
async function reconcileLights(allItems) {
    const myTokens   = allItems.filter(isOwnedByMe);
    const myTokenIds = new Set(myTokens.map(t => t.id));

    const toDelete = [];
    const toAdd    = [];

    // 1. Drop lights for tokens we no longer own.
    for (const [tokenId, entry] of [...tokenToLight.entries()]) {
        if (!myTokenIds.has(tokenId)) {
            toDelete.push(entry.lightId);
            tokenToLight.delete(tokenId);
        }
    }

    // 2. For each token we own: figure out the params we WANT, compare against
    //    the params our existing local light WAS built with, rebuild on mismatch.
    for (const token of myTokens) {
        const dfLight = findAttachedLight(allItems, token.id);
        const wanted  = dfLight ? extractParams(dfLight) : defaultParams();
        const hash    = paramsHash(wanted);

        const existing = tokenToLight.get(token.id);
        if (existing && existing.paramsHash === hash) continue;

        if (existing) toDelete.push(existing.lightId);

        const light = buildLocalLight(token, wanted);
        tokenToLight.set(token.id, { lightId: light.id, paramsHash: hash });
        toAdd.push(light);
    }

    if (toDelete.length) await OBR.scene.local.deleteItems(toDelete);
    if (toAdd.length)    await OBR.scene.local.addItems(toAdd);
}

async function clearAllLocalLights() {
    const ids = Array.from(tokenToLight.values()).map(e => e.lightId);
    if (ids.length) await OBR.scene.local.deleteItems(ids);
    tokenToLight.clear();
}

/* ----- Optional: context-menu hook to assign explicit ownership -----------
 *
 * GMs can right-click a token and assign it to a specific player. The
 * assignment is written to shared metadata so every client's copy of this
 * extension can read it — but the actual vision render still happens only
 * in the assigned player's local scene.
 * -------------------------------------------------------------------------*/

OBR.onReady(async () => {
    if ((await OBR.player.getRole()) !== "GM") return;
    OBR.contextMenu.create({
        id: `${EXTENSION_ID}/assign-owner`,
        icons: [{
            icon: "https://mehiskasonen.github.io/chromodynamic-fog/icon.svg",
            label: "Assign vision owner",
            filter: { every: [{ key: "layer", value: "CHARACTER" }] },
        }],
        embed: {
            url: `https://mehiskasonen.github.io/chromodynamic-fog/assign.html`,
            height: 320,
        },
    });
});
