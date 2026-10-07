import { useId, type ReactNode } from "react";

/**
 * Tool marks, and the catalogue of tools the site names.
 *
 * ICONS. Every glyph below is real brand artwork rather than a geometric stand
 * in. The path data is reproduced from Simple Icons (https://simpleicons.org),
 * whose icon set is published under CC0 1.0 and whose source is MIT licensed,
 * copied into this file verbatim at version 16.28.0. Nothing is hotlinked and
 * nothing is fetched at runtime: the paths ship inside the bundle, drawn at
 * 24 units, filled with `currentColor`, so each one follows the theme like any
 * other piece of type. Provider colour comes from the canonical product token
 * sheet, with multicolour artwork retaining its official gradient.
 *
 * Simple Icons deliberately does not carry a mark for OpenAI, Google
 * Antigravity or Together, so those three fall back to `InitialMark`, a clean
 * lettered tile drawn here. Nothing renders blank.
 *
 * HONESTY. The catalogue is split in two and the split is the whole point.
 * `todayTools` are the six connectors that ship in this release. `plannedTools`
 * are well known tools with no connector yet, and every surface that renders
 * one has to render its `planned` chip beside it. Any tool in either list can
 * be metered today by hand, which is what the manual entry note says.
 */

export interface ToolMarkProps {
  /** Sizing only. Colour comes from the shared provider token. */
  className?: string;
}

/** Every mark on the site is one of these: 24 units, filled, decorative. */
function BrandGlyph({
  path,
  provider,
  className = "h-5 w-5",
}: ToolMarkProps & { path: string; provider?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`${className} ol-provider-glyph`}
      data-provider={provider}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
    </svg>
  );
}

/**
 * The fallback for a tool with no published mark: its initials in a rounded
 * tile, drawn at the same 24 units and in the same `currentColor` as the real
 * glyphs, so a row of tiles keeps one weight and one rhythm.
 */
function InitialMark({
  initials,
  className = "h-5 w-5",
}: ToolMarkProps & { initials: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <rect
        x="1.6"
        y="1.6"
        width="20.8"
        height="20.8"
        rx="5.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <text
        x="12"
        y="12.6"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="currentColor"
        fontSize="9.5"
        fontWeight="600"
        letterSpacing="-0.3"
        className="font-sans"
      >
        {initials}
      </text>
    </svg>
  );
}

/* Simple Icons path data, verbatim. One constant per mark, so a future refresh
   of the set is a copy over one string rather than an edit inside markup. */

const CLAUDE_PATH =
  "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";

const OPENAI_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

const GOOGLE_PATH =
  "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z";

const OPENCODE_PATH = "M22 24H2V0h20zM17 4.8H7v14.4h10z";

const OPENROUTER_PATH =
  "M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z";

const PERPLEXITY_PATH =
  "M22.3977 7.0896h-2.3106V.0676l-7.5094 6.3542V.1577h-1.1554v6.1966L4.4904 0v7.0896H1.6023v10.3976h2.8882V24l6.932-6.3591v6.2005h1.1554v-6.0469l6.9318 6.1807v-6.4879h2.8882V7.0896zm-3.4657-4.531v4.531h-5.355l5.355-4.531zm-13.2862.0676 4.8691 4.4634H5.6458V2.6262zM2.7576 16.332V8.245h7.8476l-6.1149 6.1147v1.9723H2.7576zm2.8882 5.0404v-3.8852h.0001v-2.6488l5.7763-5.7764v7.0111l-5.7764 5.2993zm12.7086.0248-5.7766-5.1509V9.0618l5.7766 5.7766v6.5588zm2.8882-5.0652h-1.733v-1.9723L13.3948 8.245h7.8478v8.087z";

const X_PATH =
  "M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z";

const GEMINI_PATH =
  "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81";

const COPILOT_PATH =
  "M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z";

const CURSOR_PATH =
  "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23";

const OLLAMA_PATH =
  "M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007Zm4.184 2c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002zm-5.503-11a1.653 1.653 0 0 0-.683.298C5.617.74 5.173 1.666 4.985 2.819c-.07.436-.119 1.04-.119 1.503 0 .544.064 1.24.155 1.721.02.107.031.202.023.208a8.12 8.12 0 0 1-.187.152 5.324 5.324 0 0 0-.949 1.02 5.49 5.49 0 0 0-.94 2.339 6.625 6.625 0 0 0-.023 1.357c.091.78.325 1.438.727 2.04l.13.195-.037.064c-.269.452-.498 1.105-.605 1.732-.084.496-.095.629-.095 1.294 0 .67.009.803.088 1.266.095.555.288 1.143.503 1.534.071.128.243.393.264.407.007.003-.014.067-.046.141a7.405 7.405 0 0 0-.548 1.873c-.062.417-.071.552-.071.991 0 .56.031.832.148 1.279L3.42 24h1.478l-.05-.091c-.297-.552-.325-1.575-.068-2.597.117-.472.25-.819.498-1.296l.148-.29v-.177c0-.165-.003-.184-.057-.293a.915.915 0 0 0-.194-.25 1.74 1.74 0 0 1-.385-.543c-.424-.92-.506-2.286-.208-3.451.124-.486.329-.918.544-1.154a.787.787 0 0 0 .223-.531c0-.195-.07-.355-.224-.522a3.136 3.136 0 0 1-.817-1.729c-.14-.96.114-2.005.69-2.834.563-.814 1.353-1.336 2.237-1.475.199-.033.57-.028.776.01.226.04.367.028.512-.041.179-.085.268-.19.374-.431.093-.215.165-.333.36-.576.234-.29.46-.489.822-.729.413-.27.884-.467 1.352-.561.17-.035.25-.04.569-.04.319 0 .398.005.569.04a4.07 4.07 0 0 1 1.914.997c.117.109.398.457.488.602.034.057.095.177.132.267.105.241.195.346.374.43.14.068.286.082.503.045.343-.058.607-.053.943.016 1.144.23 2.14 1.173 2.581 2.437.385 1.108.276 2.267-.296 3.153-.097.15-.193.27-.333.419-.301.322-.301.722-.001 1.053.493.539.801 1.866.708 3.036-.062.772-.26 1.463-.533 1.854a2.096 2.096 0 0 1-.224.258.916.916 0 0 0-.194.25c-.054.109-.057.128-.057.293v.178l.148.29c.248.476.38.823.498 1.295.253 1.008.231 2.01-.059 2.581a.845.845 0 0 0-.044.098c0 .006.329.009.732.009h.73l.02-.074.036-.134c.019-.076.057-.3.088-.516.029-.217.029-1.016 0-1.258-.11-.875-.295-1.57-.597-2.226-.032-.074-.053-.138-.046-.141.008-.005.057-.074.108-.152.376-.569.607-1.284.724-2.228.031-.26.031-1.378 0-1.628-.083-.645-.182-1.082-.348-1.525a6.083 6.083 0 0 0-.329-.7l-.038-.064.131-.194c.402-.604.636-1.262.727-2.04a6.625 6.625 0 0 0-.024-1.358 5.512 5.512 0 0 0-.939-2.339 5.325 5.325 0 0 0-.95-1.02 8.097 8.097 0 0 1-.186-.152.692.692 0 0 1 .023-.208c.208-1.087.201-2.443-.017-3.503-.19-.924-.535-1.658-.98-2.082-.354-.338-.716-.482-1.15-.455-.996.059-1.8 1.205-2.116 3.01a6.805 6.805 0 0 0-.097.726c0 .036-.007.066-.015.066a.96.96 0 0 1-.149-.078A4.857 4.857 0 0 0 12 3.03c-.832 0-1.687.243-2.456.698a.958.958 0 0 1-.148.078c-.008 0-.015-.03-.015-.066a6.71 6.71 0 0 0-.097-.725C8.997 1.392 8.337.319 7.46.048a2.096 2.096 0 0 0-.585-.041Zm.293 1.402c.248.197.523.759.682 1.388.03.113.06.244.069.292.007.047.026.152.041.233.067.365.098.76.102 1.24l.002.475-.12.175-.118.178h-.278c-.324 0-.646.041-.954.124l-.238.06c-.033.007-.038-.003-.057-.144a8.438 8.438 0 0 1 .016-2.323c.124-.788.413-1.501.696-1.711.067-.05.079-.049.157.013zm9.825-.012c.17.126.358.46.498.888.28.854.36 2.028.212 3.145-.019.14-.024.151-.057.144l-.238-.06a3.693 3.693 0 0 0-.954-.124h-.278l-.119-.178-.119-.175.002-.474c.004-.669.066-1.19.214-1.772.157-.623.434-1.185.68-1.382.078-.062.09-.063.159-.012z";

const LM_STUDIO_PATH =
  "M14.025 0c3.492 0 5.237 0 6.571.68a6.24 6.24 0 0 1 2.725 2.724C24 4.738 24 6.484 24 9.975v4.05c0 3.492 0 5.237-.68 6.571a6.24 6.24 0 0 1-2.724 2.725c-1.334.679-3.08.679-6.571.679h-4.05c-3.492 0-5.237 0-6.571-.68A6.24 6.24 0 0 1 .68 20.597C0 19.262 0 17.516 0 14.025v-4.05c0-3.492 0-5.237.68-6.571A6.23 6.23 0 0 1 3.404.68C4.738 0 6.484 0 9.975 0zM7.688 16.313a1.313 1.313 0 0 0 0 2.625h11.625a1.313 1.313 0 0 0 0-2.625zm-3-3.75a1.313 1.313 0 0 0 0 2.624h11.625a1.313 1.313 0 0 0 0-2.624zm3-3.75a1.313 1.313 0 0 0 0 2.624h11.625a1.313 1.313 0 0 0 0-2.624zm-3-3.75a1.313 1.313 0 0 0 0 2.625h11.625a1.313 1.313 0 0 0 0-2.625z";

const MISTRAL_PATH =
  "M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z";

const DEEPSEEK_PATH =
  "M22.759 5.287C22.528 5.174 22.429 5.389 22.294 5.499C22.248 5.534 22.209 5.58 22.17 5.622C21.832 5.982 21.438 6.219 20.924 6.191C20.171 6.148 19.529 6.385 18.961 6.96C18.841 6.251 18.44 5.827 17.829 5.555C17.51 5.414 17.187 5.273 16.963 4.966C16.807 4.747 16.764 4.503 16.686 4.263C16.637 4.118 16.587 3.97 16.42 3.945C16.239 3.917 16.168 4.069 16.097 4.196C15.813 4.715 15.703 5.287 15.714 5.866C15.739 7.169 16.289 8.207 17.382 8.944C17.506 9.029 17.538 9.114 17.499 9.237C17.425 9.492 17.336 9.739 17.258 9.993C17.208 10.155 17.134 10.191 16.96 10.12C16.36 9.869 15.842 9.499 15.384 9.05C14.607 8.298 13.904 7.469 13.027 6.819C12.822 6.667 12.616 6.526 12.403 6.392C11.508 5.523 12.52 4.81 12.754 4.726C12.999 4.637 12.839 4.334 12.048 4.337C11.256 4.341 10.532 4.606 9.61 4.959C9.475 5.012 9.333 5.05 9.187 5.082C8.35 4.923 7.48 4.888 6.572 4.99C4.861 5.181 3.495 5.989 2.491 7.37C1.284 9.029 1 10.914 1.348 12.881C1.713 14.953 2.771 16.669 4.396 18.01C6.082 19.401 8.023 20.083 10.238 19.952C11.583 19.875 13.081 19.694 14.77 18.265C15.196 18.477 15.643 18.561 16.385 18.625C16.956 18.678 17.506 18.597 17.932 18.508C18.599 18.367 18.553 17.749 18.312 17.636C16.356 16.725 16.786 17.096 16.395 16.796C17.389 15.62 18.887 14.399 19.472 10.441C19.518 10.127 19.479 9.929 19.472 9.675C19.469 9.52 19.504 9.46 19.682 9.442C20.171 9.386 20.647 9.252 21.084 9.012C22.351 8.32 22.862 7.183 22.982 5.82C23 5.612 22.979 5.396 22.759 5.287ZM11.718 17.551C9.823 16.062 8.904 15.571 8.524 15.592C8.169 15.613 8.233 16.019 8.311 16.284C8.392 16.545 8.499 16.725 8.648 16.955C8.751 17.107 8.822 17.333 8.545 17.502C7.935 17.88 6.874 17.375 6.824 17.35C5.589 16.623 4.556 15.663 3.828 14.349C3.126 13.086 2.718 11.73 2.65 10.282C2.633 9.933 2.735 9.809 3.083 9.746C3.541 9.661 4.013 9.643 4.471 9.71C6.405 9.993 8.052 10.858 9.432 12.228C10.22 13.008 10.816 13.94 11.43 14.851C12.083 15.818 12.786 16.74 13.68 17.495C13.996 17.76 14.248 17.961 14.49 18.109C13.762 18.191 12.548 18.208 11.718 17.551ZM12.626 11.709C12.626 11.553 12.751 11.43 12.907 11.43C12.942 11.43 12.974 11.437 13.003 11.447C13.042 11.462 13.077 11.483 13.105 11.515C13.155 11.564 13.184 11.635 13.184 11.709C13.184 11.864 13.059 11.988 12.903 11.988C12.747 11.988 12.626 11.864 12.626 11.709ZM15.448 13.156C15.267 13.23 15.086 13.294 14.912 13.301C14.642 13.315 14.348 13.206 14.188 13.071C13.94 12.863 13.762 12.747 13.688 12.383C13.656 12.228 13.673 11.988 13.702 11.85C13.766 11.553 13.695 11.363 13.485 11.19C13.315 11.048 13.098 11.01 12.861 11.01C12.772 11.01 12.69 10.971 12.63 10.939C12.531 10.89 12.449 10.766 12.527 10.614C12.552 10.565 12.673 10.445 12.701 10.424C13.024 10.24 13.397 10.3 13.741 10.438C14.06 10.568 14.302 10.808 14.649 11.147C15.004 11.557 15.068 11.67 15.27 11.977C15.43 12.217 15.576 12.464 15.675 12.747C15.735 12.923 15.657 13.068 15.448 13.156Z";

const KIMI_PATH =
  "M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441";

/* The published marks. */

export function ClaudeMark({ className }: ToolMarkProps) {
  return <BrandGlyph path={CLAUDE_PATH} provider="CLAUDE" className={className} />;
}

/**
 * Antigravity's polychrome logo: a smooth arch with flared feet carrying a gradient
 * from red-orange at top through green to blue at the base.
 */
export function AntigravityMark({ className = "h-5 w-5" }: ToolMarkProps) {
  const gradientId = `${useId().replaceAll(":", "")}-antigravity-gradient`;
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="12" y1="1.8" x2="12" y2="22.4" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--ol-provider-google-red)" />
          <stop offset="0.34" stopColor="var(--ol-provider-google-yellow)" />
          <stop offset="0.66" stopColor="var(--ol-provider-google-green)" />
          <stop offset="1" stopColor="var(--ol-provider-google-blue)" />
        </linearGradient>
      </defs>
      <path
        d="M12 1.8C14.8 1.8 17.1 7.8 19.6 14.2C20.5 16.5 21.4 19 21.4 20.2C21.4 21.8 19.8 22.4 17.8 20.6C16.3 16.8 14.1 12.5 12 12.5C9.9 12.5 7.7 16.8 6.2 20.6C4.2 22.4 2.6 21.8 2.6 20.2C2.6 19 3.5 16.5 4.4 14.2C6.9 7.8 9.2 1.8 12 1.8Z"
        fill={`url(#${gradientId})`}
      />
    </svg>
  );
}

export function GoogleMark({ className }: ToolMarkProps) {
  return <BrandGlyph path={GOOGLE_PATH} className={className} />;
}

export function OpenCodeMark({ className }: ToolMarkProps) {
  return <BrandGlyph path={OPENCODE_PATH} provider="OPENCODE" className={className} />;
}

export function OpenRouterMark({ className }: ToolMarkProps) {
  return <BrandGlyph path={OPENROUTER_PATH} provider="OPENROUTER" className={className} />;
}

export function PerplexityMark({ className }: ToolMarkProps) {
  return <BrandGlyph path={PERPLEXITY_PATH} className={className} />;
}

export function XaiMark({ className }: ToolMarkProps) {
  return <BrandGlyph path={X_PATH} provider="GROK" className={className} />;
}

export function GeminiMark({ className }: ToolMarkProps) {
  const gradientId = `${useId().replaceAll(":", "")}-gemini-gradient`;
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gradientId} x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--ol-provider-gemini-blue)" />
          <stop offset="0.52" stopColor="var(--ol-provider-gemini-purple)" />
          <stop offset="1" stopColor="var(--ol-provider-gemini-coral)" />
        </linearGradient>
      </defs>
      <path d={GEMINI_PATH} fill={`url(#${gradientId})`} />
    </svg>
  );
}

export function CopilotMark({ className }: ToolMarkProps) {
  return <BrandGlyph path={COPILOT_PATH} className={className} />;
}

export function CursorMark({ className }: ToolMarkProps) {
  return <BrandGlyph path={CURSOR_PATH} className={className} />;
}

/**
 * Devin Desktop, which was Windsurf until Cognition renamed it on 2026-06-02.
 *
 * The old mark is retired with the old name: windsurf.com and its documentation
 * now redirect to devin.ai, so drawing the Windsurf glyph here would put a dead
 * brand on the page beside a live one. There is no clean official mark to
 * replace it with, so this falls back to the lettered tile every unmarked tool
 * on this page uses rather than guessing at somebody's artwork.
 */
export function DevinDesktopMark({ className }: ToolMarkProps) {
  return <InitialMark initials="DD" className={className} />;
}

export function OllamaMark({ className }: ToolMarkProps) {
  return <BrandGlyph path={OLLAMA_PATH} className={className} />;
}

export function LmStudioMark({ className }: ToolMarkProps) {
  return <BrandGlyph path={LM_STUDIO_PATH} className={className} />;
}

export function MistralMark({ className }: ToolMarkProps) {
  return <BrandGlyph path={MISTRAL_PATH} className={className} />;
}

export function DeepSeekMark({ className }: ToolMarkProps) {
  return <BrandGlyph path={DEEPSEEK_PATH} provider="DEEPSEEK" className={className} />;
}

export function KimiMark({ className }: ToolMarkProps) {
  return <BrandGlyph path={KIMI_PATH} provider="KIMI" className={className} />;
}

export function OpenAIMark({ className }: ToolMarkProps) {
  return <BrandGlyph path={OPENAI_PATH} provider="CODEX" className={className} />;
}

/* The three with no published mark, and the one that is not a brand at all. */

export function CodexMark({ className }: ToolMarkProps) {
  return <OpenAIMark className={className} />;
}

export function TogetherMark({ className }: ToolMarkProps) {
  return <InitialMark initials="TG" className={className} />;
}

/** Manual entry is a person with a keyboard, not a company. */
export function ManualMark({ className = "h-5 w-5" }: ToolMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M16.6 3.6a2 2 0 0 1 2.8 2.8L8.5 17.3l-3.7.9.9-3.7Z" />
      <path d="m14.6 5.6 3.8 3.8M4 21h16" />
    </svg>
  );
}

/**
 * One entry in the catalogue.
 *
 * `state` is the honesty switch. `today` means a connector ships in this
 * release; `planned` means the name is known and the connector is not written,
 * and every renderer has to say so.
 */
export interface Tool {
  readonly name: string;
  readonly Mark: (props: ToolMarkProps) => ReactNode;
  readonly state: "today" | "planned";
  /** One short line, honest about what the connector does or does not do. */
  readonly detail: string;
  /**
   * The name this product shipped under before it was renamed.
   *
   * Present only where a rename actually happened. It exists so a reader who
   * knows the old name can still recognise the row, without the old name being
   * presented as current anywhere.
   */
  readonly formerly?: string;
}

/**
 * What a tool's hover text says, in one place, for every surface.
 *
 * A tool's name is a proper noun and is the same in every language. What is
 * around it is a sentence: this one is planned, this one used to be called
 * something else. So the name arrives as an argument and the sentence comes from
 * `tools.title` in the catalogs, which every surface rendering a tool mark reads.
 *
 * The translator is required rather than optional. It was briefly optional, with
 * an English fallback, while two lanes converted these callers at once; keeping
 * that would have left a second copy of the same three sentences in code, and a
 * caller that forgot to pass one would render untranslated text with nothing to
 * show it had gone wrong.
 */
export function toolTitle(
  tool: Tool,
  t: (
    key: "formerly" | "formerlyPlanned" | "planned",
    values: { name: string; formerly?: string },
  ) => string,
): string {
  if (tool.formerly !== undefined && tool.state === "planned") {
    return t("formerlyPlanned", { name: tool.name, formerly: tool.formerly });
  }
  if (tool.formerly !== undefined) {
    return t("formerly", { name: tool.name, formerly: tool.formerly });
  }
  if (tool.state === "planned") {
    return t("planned", { name: tool.name });
  }
  return tool.name;
}

/** The eight collectors that ship. Order matches every product surface. */
export const todayTools: readonly Tool[] = [
  {
    name: "Claude Code",
    Mark: ClaudeMark,
    state: "today",
    detail: "Reads the rate limit block Claude Code already hands your statusline.",
  },
  {
    name: "OpenAI Codex",
    Mark: OpenAIMark,
    state: "today",
    detail: "Reads the usage shape the Codex tooling writes. Internal, so it can change.",
  },
  {
    name: "Google Antigravity",
    Mark: AntigravityMark,
    state: "today",
    detail: "Reads the quota shape the Antigravity tooling writes. Internal too.",
  },
  {
    name: "Gemini CLI",
    Mark: GeminiMark,
    state: "today",
    detail: "Reads the model quota response through the installed Gemini CLI session.",
  },
  {
    name: "Grok Build",
    Mark: XaiMark,
    state: "today",
    detail: "Reads subscription windows through the installed Grok session.",
  },
  {
    name: "Kimi",
    Mark: KimiMark,
    state: "today",
    detail: "Reads subscription windows through the installed Kimi session.",
  },
  {
    name: "OpenCode",
    Mark: OpenCodeMark,
    state: "today",
    detail: "Reads the usage view behind a session you already opened.",
  },
  {
    name: "OpenRouter",
    Mark: OpenRouterMark,
    state: "today",
    detail: "Reads the credits shape OpenRouter documents, with a key you hold.",
  },
];

/** The hero repeats the same eight collectors and no roadmap names. */
export const heroMarks: readonly Tool[] = todayTools;

/*
 * The one sentence that makes a planned chip fair rather than a tease used to be
 * written here, as `MANUAL_TODAY_NOTE`. It renders on the agent grid and nowhere
 * else, so it moved to `worksWith.manualNote` in the catalogs with the rest of
 * that section's copy. This note records where it went.
 */
