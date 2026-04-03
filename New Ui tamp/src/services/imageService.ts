import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function generateAssetAllocationImage() {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        {
          text: 'A close-up, high-definition photo-realistic rendering of a financial portfolio asset allocation dashboard on a high-end smartphone screen. The view is a clean, precise, dark-themed UI. At the top of the interface, the Hebrew title "חלוקת נכסים" (Asset Allocation) is centered in white. Below the title, there are four horizontal asset bars. Each of the four bars (Maniot, Ag\'ach, M\'zumman, Medadim) is rendered with a perfectly identical, uniform, precise, and consistent pixel-perfect thickness, creating a geometrically perfect horizontal alignment. The length of each bar correctly represents its percentage. The top bar ("Maniot") is turquoise and long (75%). The middle two bars ("Ag\'ach" and "M\'zumman") are the same medium-length: one is dark gray (Ag\'ach, 10%), and the other is light blue (M\'zumman, 10%). The bottom bar ("Medadim") is a very short, identical-thickness line with a small, perfectly round purple endpoint of the same line thickness (5%). To the left of each bar, the numerical and percentage values are sharp and clearly visible (e.g., ₪2,815,626 75.0%). To the right of each bar, the asset names in Hebrew are precisely aligned. The entire layout is symmetrical, clean, and professional, optimized for a phone screen. The background is a clean dark gray.',
        },
      ],
    },
    config: {
      imageConfig: {
        aspectRatio: "9:16",
      },
    },
  });

  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  return null;
}
