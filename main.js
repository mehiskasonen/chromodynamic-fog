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
} from "https://esm.sh/@owlbear-rodeo/sdk@3";

/* ----- Configuration -------------------------------------------------------*/

const EXTENSION_ID = "com.example.chromofog";
const OWNER_META_KEY = `${EXTENSION_ID}/ownerId`;
const LIGHT_TAG_KEY = `${EXTENSION_ID}/lightFor`; // marks lights we own
const DEFAULT_VISION_GRID_SQUARES = 8;            // ~40 ft on a 5-ft grid
const GM_SEES_ALL = true;                         // GMs reveal from all tokens

/* ----- Runtime state (LOCAL to this browser tab only) ---------------------*/

let myPlayerId = null;       // OBR.player.getId() result for THIS client
let myRole = "PLAYER";       // "GM" or "PLAYER"
let gridDpi = 150;           // pixels per grid square, cached from OBR.scene.grid
let visionRadiusPx = 0;      // computed from grid dpi * DEFAULT_VISION_GRID_SQUARES

// Map<tokenId, lightItemId> — tracks which local light corresponds to which
// shared token, so we can update/remove cleanly. Lives only in this tab.
const tokenToLightId = new Map();

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

/**
 * Given the current full shared-scene items list, make sure the LOCAL scene
 * has exactly one light per token-I-own, positioned correctly, and zero
 * lights for anything else.
 *
 * Strategy: diff against tokenToLightId. This runs on every onChange tick,
 * so it must be cheap and idempotent.
 */
async function reconcileLights(allItems) {
    const myTokens = allItems.filter(isOwnedByMe);
    const myTokenIds = new Set(myTokens.map((t) => t.id));

    // --- 1. Remove lights for tokens we no longer own / that vanished -------
    const orphanLightIds = [];
    for (const [tokenId, lightId] of tokenToLightId.entries()) {
        if (!myTokenIds.has(tokenId)) {
            orphanLightIds.push(lightId);
            tokenToLightId.delete(tokenId);
        }
    }
    if (orphanLightIds.length) {
        await OBR.scene.local.deleteItems(orphanLightIds);
    }

    // --- 2. Add lights for newly-owned tokens -------------------------------
    // Because lights are .attachedTo() the token, OBR will move them with the
    // token automatically — we do NOT need to manually rewrite light.position
    // on every onChange tick when only position changed. That's the engine's
    // job. We only re-add when ownership/membership changes.
    const newLights = [];
    for (const token of myTokens) {
        if (tokenToLightId.has(token.id)) continue;

        const light = buildLight()
            .position(token.position)
            .attenuationRadius(visionRadiusPx)
            // sourceRadius controls the "soft" inner circle — anything inside it
            // is fully revealed with no falloff. A small value gives a sharp edge.
            .sourceRadius(gridDpi * 0.5)
            .falloff(1)               // 0 = hard edge, 1 = smooth gradient
            .attachedTo(token.id)     // <-- this is what makes the light follow
            .metadata({ [LIGHT_TAG_KEY]: token.id })
            // Disable user interaction so players can't accidentally drag the
            // invisible light off their own token.
            .disableAttachmentBehavior(["ROTATION"])
            .build();

        tokenToLightId.set(token.id, light.id);
        newLights.push(light);
    }
    if (newLights.length) {
        // CRITICAL: addItems on OBR.scene.local — NOT OBR.scene.items.
        // This is the one-line difference between "shared party fog" and
        // "private per-player vision".
        await OBR.scene.local.addItems(newLights);
    }
}

async function clearAllLocalLights() {
    const ids = Array.from(tokenToLightId.values());
    if (ids.length) await OBR.scene.local.deleteItems(ids);
    tokenToLightId.clear();
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

    // Build the list of players once; refresh it if party changes.
    const refreshMenu = async () => {
        const party = await OBR.party.getPlayers();
        const me = await OBR.player.getId();
        const everyone = [{ id: me, name: "(me — GM)" }, ...party];

        OBR.contextMenu.create({
            id: `${EXTENSION_ID}/assign-owner`,
            icons: [{
                icon: "https://YOUR-DOMAIN.example/icon.svg",
                label: "Assign vision owner",
                filter: { every: [{ key: "layer", value: "CHARACTER" }] },
            }],
            embed: {
                url: `https://YOUR-DOMAIN.example/assign.html`,
                height: 60 + everyone.length * 32,
            },
        });
    };
    await refreshMenu();
    OBR.party.onChange(refreshMenu);
});