import * as fs from "fs-extra";
import { join } from "path";
import { flow, pipe } from "fp-ts/function";
import * as RT from "fp-ts/ReaderTask";
import * as db from "./token-image-db";
import type { SocketSessionRecord } from "./socket-session-store";

type ViewerRole = "unauthenticated" | "admin" | "user";

type SessionDependency = { session: SocketSessionRecord };

const isAdmin = (viewerRole: ViewerRole) => viewerRole === "admin";

const checkAdmin = (): RT.ReaderTask<SessionDependency, void> => (d) =>
  isAdmin(d.session.role)
    ? () => Promise.resolve(undefined)
    : () => Promise.reject(new Error("Insufficient permissions."));

const checkAuthenticated = (): RT.ReaderTask<SessionDependency, void> => (d) =>
  d.session.role === "unauthenticated"
    ? () => Promise.reject(new Error("Insufficient permissions."))
    : () => Promise.resolve(undefined);

export const TokenImageModel = db.TokenImageModel;
export const getTokenImageBySHA256 = db.getTokenImageBySHA256;
export const getTokenImageById = db.getTokenById;

export type TokenImageType = db.TokenImageType;

export const getTokenById = (id: string) =>
  pipe(
    checkAuthenticated(),
    RT.chainW(() => db.getTokenById(parseInt(id, 10)))
  );

export const isTypeOfTokenImage = db.TokenImageModel.is;

type TokenImageUploadRegisterRecord = {
  sha256: string;
  fileExtension: string;
  createdAt: Date;
};

export type TokenImageUploadRegister = Map<
  string,
  TokenImageUploadRegisterRecord
>;

type TokenImageUploadRegisterDependency = {
  tokenImageUploadRegister: TokenImageUploadRegister;
  publicUrl: string;
  fileStoragePath: string;
};

export const createTokenImageUploadRegister = (): TokenImageUploadRegister =>
  new Map();

export type RequestTokenImageUploadDuplicate = {
  type: "Duplicate";
  tokenImage: db.TokenImageType;
};

export type RequestTokenImageUploadUrl = {
  type: "Url";
  uploadUrl: string;
};

export type RequestTokenImageUploadResult =
  | RequestTokenImageUploadDuplicate
  | RequestTokenImageUploadUrl;

export const requestTokenImageUpload = (params: {
  sha256: string;
  extension: string;
}) =>
  pipe(
    checkAdmin(),
    RT.chainW(() => getTokenImageBySHA256(params.sha256)),
    RT.chainW((tokenImage) =>
      tokenImage
        ? RT.of({
            type: "Duplicate" as const,
            tokenImage,
          } as RequestTokenImageUploadResult)
        : pipe(
            createTokenImageUploadRequestUrl(params),
            RT.map(
              (uploadUrl) =>
                ({
                  type: "Url" as const,
                  uploadUrl,
                } as RequestTokenImageUploadResult)
            )
          )
    )
  );

export const createTokenImageUploadRequestUrl = (params: {
  sha256: string;
  extension: string;
}) =>
  pipe(
    RT.ask<TokenImageUploadRegisterDependency>(),
    RT.chain((deps) => () => {
      let record = deps.tokenImageUploadRegister.get(params.sha256);

      if (!record) {
        record = {
          sha256: params.sha256,
          fileExtension: params.extension,
          createdAt: new Date(),
        };
      }

      deps.tokenImageUploadRegister.set(params.sha256, record);
      return () =>
        Promise.resolve(
          `${deps.publicUrl}/files/token-image/${params.sha256}.${params.extension}`
        );
    })
  );

const buildTokenImagePath = (fileStoragePath: string) =>
  join(fileStoragePath, "token-image");

export const storeTokenImageUpload = (params: {
  sha256: string;
  fileExtension: string;
  readStream: fs.ReadStream;
}) =>
  pipe(
    RT.ask<TokenImageUploadRegisterDependency>(),
    RT.chain((deps) => () => async () => {
      if (deps.tokenImageUploadRegister.has(params.sha256) === false) {
        return Promise.reject(
          new Error("The upload of this file has not been requested.")
        );
      }
      const directory = buildTokenImagePath(deps.fileStoragePath);
      const file = join(directory, `${params.sha256}.${params.fileExtension}`);

      await fs.mkdirp(directory);
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(file);
        params.readStream.pipe(writeStream);
        params.readStream.once("error", (error) => {
          writeStream.close();
          reject(error);
        });
        writeStream.once("end", () => {
          resolve();
        });
      });
    })
  );

export type CreateTokenImageSuccess = {
  type: "Success";
  tokenImageId: number;
};

export type CreateTokenImageFailure = {
  type: "Failure";
};

export type CreateTokenImageResult =
  | CreateTokenImageSuccess
  | CreateTokenImageFailure;

export const createTokenImage = (params: { sha256: string }) =>
  pipe(
    checkAdmin(),
    RT.chainW(() => RT.ask<TokenImageUploadRegisterDependency>()),
    RT.chainW((deps) => {
      const record = deps.tokenImageUploadRegister.get(params.sha256);
      if (!record) {
        return RT.of({
          type: "Failure",
        } as CreateTokenImageResult);
      }
      return pipe(
        () =>
          fs.pathExists(
            join(
              buildTokenImagePath(deps.fileStoragePath),
              `${record.sha256}.${record.fileExtension}`
            )
          ),
        RT.fromTask,
        RT.chainW((exists) =>
          exists
            ? pipe(
                db.createTokenImage(record),
                RT.map((tokenImageId) =>
                  RT.of({
                    type: "Success",
                    tokenImageId,
                  } as CreateTokenImageResult)
                ),
                RT.flatten
              )
            : RT.of({
                type: "Failure",
              } as CreateTokenImageResult)
        )
      );
    })
  );
