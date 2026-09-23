import { Type } from "typebox";

export const observeSchema = Type.Object({
  app: Type.String({ minLength: 1, maxLength: 200, description: "Application name as shown in the menu bar, for example TextEdit or Finder. The application must already be open." }),
  window_title: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: "Optional case-insensitive substring of the window title. Omit to use the frontmost titled window of the application." })),
}, { additionalProperties: false });
