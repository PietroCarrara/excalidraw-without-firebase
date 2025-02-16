import { reconcileElements } from "../../packages/excalidraw";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "../../packages/excalidraw/element/types";
import { getSceneVersion } from "../../packages/excalidraw/element";
import type Portal from "../collab/Portal";
import { restoreElements } from "../../packages/excalidraw/data/restore";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "../../packages/excalidraw/types";
import {
  byteStringToArrayBuffer,
  decompressData,
  toByteString,
} from "../../packages/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "../../packages/excalidraw/data/encryption";
import { MIME_TYPES } from "../../packages/excalidraw/constants";
import type { SyncableExcalidrawElement } from ".";
import { getSyncableElements } from ".";
import type { Socket } from "socket.io-client";
import type { RemoteExcalidrawElement } from "../../packages/excalidraw/data/reconcile";

// private
// -----------------------------------------------------------------------------

let FIREBASE_CONFIG: Record<string, any>;
try {
  FIREBASE_CONFIG = JSON.parse(import.meta.env.VITE_APP_FIREBASE_CONFIG);
} catch (error: any) {
  console.warn(
    `Error JSON parsing firebase config. Supplied value: ${
      import.meta.env.VITE_APP_FIREBASE_CONFIG
    }`,
  );
  FIREBASE_CONFIG = {};
}

// -----------------------------------------------------------------------------

type FirebaseStoredScene = {
  sceneVersion: number;
  iv: Uint8Array;
  ciphertext: Uint8Array;
};

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  return { ciphertext: encryptedBuffer, iv };
};

const decryptElements = async (
  data: FirebaseStoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = data.ciphertext;
  const iv = data.iv;

  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

class FirebaseSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return FirebaseSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    FirebaseSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return FirebaseSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const response = await fetch(
          new URL(`${prefix}/${id}`, FIREBASE_CONFIG.simpleStorageUrl),
          {
            method: "POST",
            body: buffer,
          },
        );
        if (!response.ok) {
          throw await response.text();
        }
        savedFiles.push(id);
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

const createFirebaseSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
) => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  return {
    sceneVersion,
    ciphertext: new Uint8Array(ciphertext),
    iv,
  } as FirebaseStoredScene;
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return null;
  }

  const storedScene = await saveAndReconcileToFirebase(
    roomId,
    roomKey,
    elements,
    appState,
  );

  const storedElements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  FirebaseSceneVersionCache.set(socket, storedElements);

  return storedElements;
};

async function saveAndReconcileToFirebase(
  roomId: string,
  roomKey: string,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) {
  const documentRequest = await fetch(
    new URL(`scenes/${roomId}`, FIREBASE_CONFIG.simpleStorageUrl),
  );
  if (documentRequest.status === 404) {
    const storedScene = await createFirebaseSceneDocument(elements, roomKey);

    await fetch(new URL(`scenes/${roomId}`, FIREBASE_CONFIG.simpleStorageUrl), {
      method: "POST",
      body: firebaseStoredSceneToJson(storedScene),
    });

    return storedScene;
  }

  const prevStoredScene = jsonToFirebaseStoredScene(
    await documentRequest.json(),
  );
  const prevStoredElements = getSyncableElements(
    restoreElements(await decryptElements(prevStoredScene, roomKey), null),
  );
  const reconciledElements = getSyncableElements(
    reconcileElements(
      elements,
      prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
      appState,
    ),
  );

  const storedScene = await createFirebaseSceneDocument(
    reconciledElements,
    roomKey,
  );

  await fetch(new URL(`scenes/${roomId}`, FIREBASE_CONFIG.simpleStorageUrl), {
    method: "POST",
    body: firebaseStoredSceneToJson(storedScene),
  });

  // Return the stored elements as the in memory `reconciledElements` could have mutated in the meantime
  return storedScene;
}

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const documentRequest = await fetch(
    new URL(`scenes/${roomId}`, FIREBASE_CONFIG.simpleStorageUrl),
  );
  if (!documentRequest.ok) {
    return null;
  }
  const storedScene = jsonToFirebaseStoredScene(await documentRequest.json());
  const elements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  if (socket) {
    FirebaseSceneVersionCache.set(socket, elements);
  }

  return elements;
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const url = `${FIREBASE_CONFIG.simpleStorageUrl}/${encodeURIComponent(
          prefix.replace(/^\//, ""),
        )}/${encodeURIComponent(id)}`;
        const response = await fetch(`${url}?alt=media`);
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};

function jsonToFirebaseStoredScene(json: any): FirebaseStoredScene {
  return {
    sceneVersion: json.sceneVersion,
    iv: new Uint8Array(byteStringToArrayBuffer(json.iv)),
    ciphertext: new Uint8Array(byteStringToArrayBuffer(json.ciphertext)),
  };
}

function firebaseStoredSceneToJson(scene: FirebaseStoredScene) {
  return JSON.stringify({
    sceneVersion: scene.sceneVersion,
    iv: toByteString(scene.iv),
    ciphertext: toByteString(scene.ciphertext),
  });
}
