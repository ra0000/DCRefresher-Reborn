import * as Toast from "../components/toast";
import { queryString } from "../utils/http";
import Cookies from "js-cookie";
import ky from "ky";

export default {
    name: "컨텐츠 차단",
    description: "유저, 컨텐츠 등의 보고 싶지 않은 컨텐츠들을 삭제합니다.",
    url: /gall\.dcinside\.com\/(mgallery\/|mini\/)?board\/(view|lists)/g,
    memory: {
        uuid: null,
        uuid2: null,
        uuid3: null,
        selected: {
            nick: null,
            uid: null,
            ip: null,
            code: null,
            packageIdx: null
        },
        lastSelect: 0,
        addBlock: null,
        requestBlock: null
    },
    enable: true,
    default_enable: true,
    require: ["filter", "eventBus", "block", "dom", "http"],
    func(
        filter: RefresherFilter,
        eventBus: RefresherEventBus,
        block: RefresherBlock,
        dom: RefresherDOM,
        http: RefresherHTTP
    ) {
        this.memory.uuid = filter.add(
            ".ub-writer",
            (element) => {
                const gallery = queryString("id");

                if (!gallery) return;

                const title =
                    element.parentElement?.querySelector(".gall_tit > a")
                        ?.textContent ?? "";

                const text =
                    element
                        .closest<HTMLElement>(".view_content_wrap")
                        ?.querySelector(".write_div")?.textContent ?? "";

                const nick = element.dataset.nick ?? "";
                const uid = element.dataset.uid ?? "";
                const ip = element.dataset.ip ?? "";

                const commentElement = element.closest(
                    ".reply_info, .cmt_info"
                );
                const commentContent =
                    commentElement?.querySelector(".usertxt")?.textContent ??
                    "";

                if (
                    block.checkAll(
                        {
                            TITLE: title,
                            NICK: nick,
                            ID: uid,
                            IP: ip,
                            COMMENT: commentContent
                        },
                        gallery
                    )
                ) {
                    console.log(element);
                    const post = element.parentElement!;

                    if (post.classList.contains("ub-content")) {
                        post.style.display = "none";
                        return;
                    }

                    // if (post.parentElement?.className.startsWith("reply_")) {
                    //     element.closest<HTMLElement>(".reply")!.style.display =
                    //         "none";
                    //     return;
                    // }

                    const content = post.closest<HTMLElement>(".ub-content");

                    if (content) content.style.display = "none";

                    return;
                } else if (block.check("TEXT", text, gallery)) {
                    element
                        .closest<HTMLElement>(".view_content_wrap")!
                        .querySelector<HTMLElement>(".write_div")!.innerText =
                        "게시글 내용이 차단됐습니다.";
                }

                element.oncontextmenu ??= () => {
                    this.memory.selected = {
                        nick,
                        uid,
                        ip,
                        code: null,
                        packageIdx: null
                    };
                    this.memory.lastSelect = Date.now();
                };
            },
            {
                neverExpire: true
            }
        );

        this.memory.uuid2 = filter.add(
            ".written_dccon",
            (element) => {
                const gallery = queryString("id");

                if (!gallery) return;

                const dccon =
                    (
                        element.getAttribute("src") ??
                        element?.getAttribute("data-src")
                    )
                        ?.replace(/^.*no=/g, "")
                        .replace(/^&.*$/g, "") ?? "";

                if (block.check("DCCON", dccon, gallery)) {
                    const content =
                        element.closest<HTMLElement>(".ub-content") ??
                        element.closest<HTMLElement>(".comment_dccon");

                    if (content) content.style.display = "none";
                }

                if (element.parentElement!.oncontextmenu) return;

                element.parentElement!.oncontextmenu = () => {
                    const code =
                        (
                            element?.getAttribute("src") ||
                            element?.getAttribute("data-src")
                        )
                            ?.replace(/^.*no=/g, "")
                            .replace(/^&.*$/g, "") ?? "";

                    this.memory.selected = {
                        nick: null,
                        uid: null,
                        ip: null,
                        code,
                        packageIdx: null
                    };
                    this.memory.lastSelect = Date.now();
                };
            },
            {
                neverExpire: true
            }
        );

        this.memory.uuid3 = filter.add(
            "#package_detail",
            (element) => {
                if (element.dataset.refresherDcconBlock === "true") return;

                for (const image of element.querySelectorAll<HTMLImageElement>(
                    ".img_dccon > img"
                )) {
                    image.addEventListener("contextmenu", () => {
                        const code = image.src
                            .replace(/^.*no=/g, "")
                            .replace(/^&.*$/g, "");

                        this.memory.selected = {
                            nick: null,
                            uid: null,
                            ip: null,
                            code,
                            packageIdx: null
                        };
                        this.memory.lastSelect = Date.now();
                    });
                }

                const button = document.createElement("button");
                button.setAttribute("type", "button");
                button.setAttribute("class", "btn_blue small");
                button.innerText = "전체 차단";
                button.onclick = () => {
                    const code = element
                        .querySelector<HTMLImageElement>(".info_viewimg > img")!
                        .src.replace(/^.*no=/g, "")
                        .replace(/^&.*$/g, "");

                    const params = new URLSearchParams();
                    params.set("ci_t", Cookies.get("ci_c") ?? "");
                    params.set("code", code);

                    ky.post(http.urls.dccon.detail, {
                        headers: {
                            "X-Requested-With": "XMLHttpRequest"
                        },
                        body: params
                    })
                        .json<any>()
                        .then((json) => {
                            const title = json.info.title;
                            const packageIdx = json.info.package_idx;

                            for (const { path } of json.detail) {
                                block.add(
                                    "DCCON",
                                    path,
                                    false,
                                    undefined,
                                    `${title} [${packageIdx}]`
                                );
                            }

                            Toast.show(
                                `${block.TYPE_NAMES["DCCON"]}을 차단했습니다.`,
                                false,
                                3000
                            );
                        });
                };

                element
                    .querySelector(".btn_buy")
                    ?.insertAdjacentElement("beforebegin", button);

                element.dataset.refresherDcconBlock = "true";
            },
            { neverExpire: true }
        );

        this.memory.addBlock = eventBus.on(
            "refresherUserContextMenu",
            (
                nick: string | null,
                uid: string | null,
                ip: string | null,
                code: string | null,
                packageIdx: string | null
            ) => {
                this.memory.selected = {
                    nick,
                    uid,
                    ip,
                    code,
                    packageIdx
                };
                this.memory.lastSelect = Date.now();
            }
        );

        this.memory.requestBlock = eventBus.on("refresherRequestBlock", () => {
            if (Date.now() - this.memory.lastSelect > 10000) {
                return;
            }

            const code = this.memory.selected.code;

            if (code) {
                const params = new URLSearchParams();
                params.set("ci_t", Cookies.get("ci_c") ?? "");
                params.set("code", code);

                ky.post(http.urls.dccon.detail, {
                    headers: {
                        "X-Requested-With": "XMLHttpRequest"
                    },
                    body: params
                })
                    .json<any>()
                    .then((json) => {
                        const title = json.info.title;
                        const packageIdx = json.info.package_idx;

                        block.add(
                            "DCCON",
                            code,
                            false,
                            undefined,
                            `${title} [${packageIdx}]`
                        );

                        Toast.show(
                            `${block.TYPE_NAMES["DCCON"]}을 차단했습니다.`,
                            false,
                            3000
                        );
                    });

                return;
            }

            let type: RefresherBlockType = "NICK";
            let value = this.memory.selected.nick;
            const extra = this.memory.selected.nick;

            if (this.memory.selected.uid) {
                type = "ID";
                value = this.memory.selected.uid;
            } else if (this.memory.selected.ip) {
                type = "IP";
                value = this.memory.selected.ip;
            }

            if (!value || !extra) return;

            block.add(type, value, false, undefined, extra);
            Toast.show(
                `${block.TYPE_NAMES[type]} ${value}을(를) 차단했습니다.`,
                false,
                3000
            );
        });
    },
    revoke(filter: RefresherFilter) {
        if (this.memory.uuid) filter.remove(this.memory.uuid);

        if (this.memory.uuid2) filter.remove(this.memory.uuid2);

        if (this.memory.uuid3) filter.remove(this.memory.uuid3);

        if (this.memory.addBlock) filter.remove(this.memory.addBlock);

        if (this.memory.requestBlock) filter.remove(this.memory.requestBlock);
    }
} as RefresherModule<{
    memory: {
        uuid: string | null;
        uuid2: string | null;
        uuid3: string | null;
        selected: {
            nick: string | null;
            uid: string | null;
            ip: string | null;
            code: string | null;
            packageIdx: string | null;
        };
        lastSelect: number;
        addBlock: string | null;
        requestBlock: string | null;
    };
    require: ["filter", "eventBus", "block", "dom", "http"];
}>;
