import * as Toast from "../components/toast";
import * as block from "../core/block";
import { submitComment } from "../utils/comment";
import { findNeighbor } from "../utils/dom";
import * as http from "../utils/http";
import { queryString } from "../utils/http";
import logger from "../utils/logger";
import { ScrollDetection } from "../utils/scrollDetection";
import { User } from "../utils/user";
import Cookies from "js-cookie";
import ky from "ky";
import browser from "webextension-polyfill";
import type IFrame from "../core/frame";

class PostInfo implements IPostInfo {
    id: string;
    header?: string;
    title?: string;
    date?: string;
    expire?: string;
    user?: User;
    views?: string;
    fixedUpvotes?: string;
    upvotes?: string;
    downvotes?: string;
    contents?: string;
    commentId?: string;
    commentNo?: string;
    isNotice?: boolean;
    isAdult?: boolean;
    requireCaptcha?: boolean;
    requireCommentCaptcha?: boolean;
    disabledDownvote?: boolean;
    dom?: Document;

    constructor(id: string, data: Record<string, unknown>) {
        this.id = id;

        for (const [key, value] of Object.entries(data)) {
            this[key] = value;
        }
    }
}

interface GalleryHTTPRequestArguments {
    gallery: string;
    id: string;
    commentId?: string;
    commentNo?: string;
    link?: string;
}

const ISSUE_ZOOM_ID = /\$\(document\)\.data\('comment_id',\s'.+'\);/g;
const ISSUE_ZOOM_NO = /\$\(document\)\.data\('comment_no',\s'.+'\);/g;

const QUOTES = /(["'])(?:(?=(\\?))\2.)*?\1/g;

const parse = (id: string, body: string): PostInfo => {
    const dom = new DOMParser().parseFromString(body, "text/html");

    const header = dom
        .querySelector(".title_headtext")
        ?.innerHTML?.replace(/(^\[.*]$)/g, "");

    const title = dom.querySelector(".title_subject")?.innerHTML;

    const date = dom.querySelector(".fl > .gall_date")?.innerHTML;

    let expire = dom.querySelector(
        ".view_content_wrap div.fl > span.mini_autodeltime > div.pop_tipbox > div"
    )?.innerHTML;

    if (expire) {
        expire = expire.replace(/\s자동\s삭제/, "");
    }

    const views = dom
        .querySelector(".fr > .gall_count")
        ?.innerHTML.replace(/조회\s/, "");

    const upvotes = dom
        .querySelector(".fr > .gall_reply_num")
        ?.innerHTML.replace(/추천\s/, "");

    const fixedUpvotes = dom.querySelector(".sup_num > .smallnum")?.innerHTML;

    const downvotes = dom.querySelector(
        "div.btn_recommend_box .down_num"
    )?.innerHTML;

    const content_query = dom.querySelector(".writing_view_box");

    const writeDiv = content_query?.querySelector<HTMLDivElement>(".write_div");

    if (writeDiv && writeDiv.style.width) {
        const width = writeDiv.style.width;
        writeDiv.style.width = "unset";
        writeDiv.style.maxWidth = width;
        writeDiv.style.overflow = "";
    }
    const contents = content_query?.innerHTML;

    const zoomID = body.match(ISSUE_ZOOM_ID);
    const zoomNO = body.match(ISSUE_ZOOM_NO);

    let commentId = "";
    let commentNo = "";

    if (zoomID && zoomID[0]) {
        commentId = (zoomID[0].match(QUOTES) as string[])[1].replace(/'/g, "");
    }

    if (zoomNO && zoomNO[0]) {
        commentNo = (zoomNO[0].match(QUOTES) as string[])[1].replace(/'/g, "");
    }

    const noticeElement = dom.querySelector(
        ".user_control .option_box li:first-child"
    );
    const isNotice = noticeElement?.innerHTML !== "공지 등록";

    const isAdult = dom.head.innerHTML.includes("/error/adult");

    const requireCaptcha = dom.querySelector(".recommend_kapcode") !== null;
    const requireCommentCaptcha =
        dom.querySelector(`.cmt_write_box input[name="comment_code"]`) !== null;

    const disabledDownvote = dom.querySelector(".icon_recom_down") === null;

    return new PostInfo(id, {
        header,
        title,
        date,
        expire,
        user: new User("", null, null, null).import(
            dom.querySelector(".gallview_head > .gall_writer")
        ),
        views,
        upvotes,
        fixedUpvotes,
        downvotes,
        contents,
        commentId,
        commentNo,
        isNotice,
        isAdult,
        disabledDownvote,
        requireCaptcha,
        requireCommentCaptcha,
        dom
    });
};

const client = ky.create({
    method: "POST",
    headers: {
        "X-Requested-With": "XMLHttpRequest"
    }
});

const request = {
    async vote(
        gall_id: string,
        post_id: string,
        type: number,
        code: string | undefined,
        link: string
    ) {
        Cookies.set(
            `${gall_id}${post_id}_Firstcheck${type ? "" : "_down"}`,
            "Y",
            {
                path: "/",
                domain: "dcinside.com",
                expires: new Date(new Date().getTime() + 3 * 60 * 60 * 1000)
            }
        );

        const params = new URLSearchParams();
        params.set("ci_t", Cookies.get("ci_c") ?? "");
        params.set("id", gall_id);
        params.set("no", post_id);
        params.set("mode", type ? "U" : "D");
        params.set("code_recommend", code ?? "");
        params.set("_GALLTYPE_", http.galleryTypeName(link));
        params.set("link_id", gall_id);

        const response = await client(http.urls.vote, { body: params }).text();

        const [result, counts, fixedCounts] = response.split("||");

        return {
            result,
            counts,
            fixedCounts
        };
    },

    post(link: string, gallery: string, id: string, signal: AbortSignal) {
        return ky
            .get(
                `${http.urls.base}${http.galleryType(link, "/")}${
                    http.urls.view
                }${gallery}&no=${id}`,
                { signal }
            )
            .text()
            .then((response) => parse(id, response));
    },

    /**
     * 디시인사이드 서버에 댓글을 요청합니다.
     * @param args
     * @param signal
     */
    async comments(args: GalleryHTTPRequestArguments, signal: AbortSignal) {
        if (!args.link)
            throw "link 값이 주어지지 않았습니다. (확장 프로그램 오류)";

        const galleryType = http.galleryType(args.link, "/");

        const params = new URLSearchParams();
        params.set("id", args.gallery);
        params.set("no", args.id);
        params.set("cmt_id", args.commentId ?? args.gallery);
        params.set("cmt_no", args.commentNo ?? args.id);
        params.set(
            "e_s_n_o",
            document.querySelector<HTMLInputElement>("#e_s_n_o")!.value
        );
        params.set("comment_page", "1");
        params.set("_GALLTYPE_", http.galleryTypeName(args.link));

        const response = await client(http.urls.comments, {
            body: params,
            signal
        }).text();

        return JSON.parse(response);
    },
    async delete(args: GalleryHTTPRequestArguments) {
        if (!args.link)
            throw "link 값이 주어지지 않았습니다. (확장 프로그램 오류)";

        const galleryType = http.galleryType(args.link, "/");

        const params = new URLSearchParams();
        params.set("ci_t", Cookies.get("ci_c") ?? "");
        params.set("id", args.gallery);
        params.set("nos[]", args.id);
        params.set("_GALLTYPE_", http.galleryTypeName(args.link));

        const response = await client(
            galleryType === "mini/"
                ? http.urls.manage.deleteMini
                : http.urls.manage.delete,
            {
                body: params
            }
        ).text();

        try {
            return JSON.parse(response);
        } catch {
            return response;
        }
    },

    async block(
        args: GalleryHTTPRequestArguments,
        avoid_hour: number,
        avoid_reason: number,
        avoid_reason_txt: string,
        del_chk: number
    ) {
        if (!args.link)
            throw "link 값이 주어지지 않았습니다. (확장 프로그램 오류)";

        const galleryType = http.galleryType(args.link, "/");

        const params = new URLSearchParams();
        params.set("ci_t", Cookies.get("ci_c") ?? "");
        params.set("id", args.gallery);
        params.set("nos[]", args.id);
        params.set("parent", "");
        params.set("_GALLTYPE_", http.galleryTypeName(args.link));
        params.set("avoid_hour", avoid_hour.toString());
        params.set("avoid_reason", avoid_reason.toString());
        params.set("avoid_reason_txt", avoid_reason_txt);
        params.set("del_chk", del_chk.toString());

        const response = await client(
            galleryType == "mini/"
                ? http.urls.manage.blockMini
                : http.urls.manage.block,
            {
                body: params
            }
        ).text();

        try {
            return JSON.parse(response);
        } catch {
            return response;
        }
    },

    async setNotice(args: GalleryHTTPRequestArguments, set: boolean) {
        if (!args.link) {
            throw "link 값이 주어지지 않았습니다. (확장 프로그램 오류)";
        }

        const galleryType = http.galleryType(args.link, "/");

        const params = new URLSearchParams();
        params.set("ci_t", Cookies.get("ci_c") ?? "");
        params.set("mode", set ? "SET" : "REL");
        params.set("id", args.gallery);
        params.set("no", args.id);
        params.set("_GALLTYPE_", http.galleryTypeName(args.link));

        const response = await client(
            galleryType == "mini/"
                ? http.urls.manage.setNoticeMini
                : http.urls.manage.setNotice,
            {
                body: params
            }
        ).text();

        try {
            return JSON.parse(response);
        } catch {
            return response;
        }
    },

    async setRecommend(args: GalleryHTTPRequestArguments, set: boolean) {
        if (!args.link)
            throw "link 값이 주어지지 않았습니다. (확장 프로그램 오류)";

        const galleryType = http.galleryType(args.link, "/");

        const params = new URLSearchParams();
        params.set("ci_t", Cookies.get("ci_c") ?? "");
        params.set("mode", set ? "SET" : "REL");
        params.set("id", args.gallery);
        params.set("nos[]", args.id);
        params.set("_GALLTYPE_", http.galleryTypeName(args.link));

        const response = await client(
            galleryType == "mini/"
                ? http.urls.manage.setRecommendMini
                : http.urls.manage.setRecommend,
            {
                body: params
            }
        ).text();

        try {
            return JSON.parse(response);
        } catch {
            return response;
        }
    },

    async captcha(
        args: GalleryHTTPRequestArguments,
        kcaptchaType: "comment" | "recommend"
    ) {
        if (!args.link)
            throw "link 값이 주어지지 않았습니다. (확장 프로그램 오류)";

        const galleryType = http.galleryType(args.link, "/");
        const galleryTypeName = http.galleryTypeName(args.link);

        const params = new URLSearchParams();
        params.set("ci_t", Cookies.get("ci_c") ?? "");
        params.set("gall_id", args.gallery);
        params.set("kcaptcha_type", kcaptchaType);
        params.set("_GALLTYPE_", galleryTypeName);

        await client(http.urls.captcha, { body: params });

        return (
            "/kcaptcha/image/?gall_id=" +
            args.gallery +
            "&kcaptcha_type=" +
            kcaptchaType +
            "&time=" +
            new Date().getTime() +
            "&_GALLTYPE_=" +
            galleryTypeName
        );
    },

    async adminDeleteComment(
        preData: GalleryPreData,
        commentId: string,
        signal: AbortSignal
    ): Promise<boolean | string> {
        if (!preData.link) return false;

        const typeName = http.galleryTypeName(preData.link);

        if (!typeName.length) return false;

        const url = http.checkMini(preData.link)
            ? http.urls.manage.deleteCommentMini
            : http.urls.manage.deleteComment;

        const params = new URLSearchParams();
        params.set("ci_t", Cookies.get("ci_c") ?? "");
        params.set("id", preData.gallery);
        params.set("_GALLTYPE_", typeName);
        params.set("pno", preData.id);
        params.set("cmt_nos[]", commentId);

        return client(url, { body: params, signal })
            .text()
            .then((v) => v)
            .catch(() => false);
    },

    async userDeleteComment(
        preData: GalleryPreData,
        commentId: string,
        signal: AbortSignal,
        password?: string
    ): Promise<boolean | string> {
        if (!preData.link) return false;

        const typeName = http.galleryTypeName(preData.link);

        if (!typeName.length) return false;

        const params = new URLSearchParams();
        params.set("ci_t", Cookies.get("ci_c") ?? "");
        params.set("id", preData.gallery);
        params.set("_GALLTYPE_", typeName);
        params.set("mode", "del");
        params.set("re_no", commentId);

        if (password) {
            params.set("re_password", password);
            params.set("&g-recaptcha-response", password);
        }

        return client(http.urls.comment_remove, { body: params, signal })
            .text()
            .then((v) => v)
            .catch(() => false);
    }
};

const KEY_COUNTS: Record<string, [number, number]> = {};
let adminKeyPress: (ev: KeyboardEvent) => void;

const panel = {
    block: (
        callback: (
            avoid_hour: number,
            avoid_reason: number,
            avoid_reason_txt: string,
            del_chk: number
        ) => void,
        closeCallback: () => void
    ) => {
        const element = document.createElement("div");
        element.className = "refresher-block-popup";

        element.innerHTML = `
      <div class="close">
        <div class="cross"></div>
        <div class="cross"></div>
      </div>
      <div class="contents">
        <div class="block">
          <h3>차단 기간</h3>
          <div class="block_duration">
            <label><input type="radio" name="duration" value="1" checked="checked" />1시간</label>
            <label><input type="radio" name="duration" value="6" />6시간</label>
            <label><input type="radio" name="duration" value="24" />24시간</label>
            <label><input type="radio" name="duration" value="168" />7일</label>
            <label><input type="radio" name="duration" value="336" />14일</label>
            <label><input type="radio" name="duration" value="720" />30일</label>
          </div>
        </div>
        <div class="block">
          <h3>차단 사유</h3>
          <div class="block_reason">
            <label><input type="radio" name="reason" value="1" checked="checked" />음란성</label>
            <label><input type="radio" name="reason" value="2"/>광고</label>
            <label><input type="radio" name="reason" value="3"/>욕설</label>
            <label><input type="radio" name="reason" value="4"/>도배</label>
            <label><input type="radio" name="reason" value="5"/>저작권 침해</label>
            <label><input type="radio" name="reason" value="6"/>명예훼손</label>
            <label><input type="radio" name="reason" value="0"/>직접 입력</label>
          </div>
          <input type="text" name="reason_text" style="display: none;" placeholder="차단 사유 직접 입력 (한글 20자 이내)"></input>
        </div>
        <div class="block">
          <h3>선택한 글 삭제</h3>
          <input type="checkbox" name="remove"></input>
          <button class="go-block">차단</button>
        </div>
      </div>
    `;

        let avoid_hour = 1;
        let avoid_reason = 1;

        element.querySelector(".close")?.addEventListener("click", () => {
            closeCallback();
        });

        element.querySelectorAll('input[type="radio"]').forEach((v) => {
            v.addEventListener("click", (ev) => {
                const selected = ev.target as HTMLInputElement;

                if (!selected) {
                    return;
                }

                if (selected.getAttribute("name") === "duration") {
                    avoid_hour = Number(selected.value);
                }

                if (selected.getAttribute("name") === "reason") {
                    const value = Number(selected.value);

                    const blockReasonInput =
                        document.querySelector<HTMLInputElement>(
                            'input[name="reason_text"]'
                        )!;

                    if (!value) {
                        blockReasonInput.style.display = "block";
                    } else {
                        blockReasonInput.style.display = "none";
                    }

                    avoid_reason = value;
                }
            });
        });

        element.querySelector(".go-block")!.addEventListener("click", () => {
            const avoid_reason_txt = element.querySelector<HTMLInputElement>(
                `input[name=reason_text]`
            )!.value;
            const del_chk =
                element.querySelector<HTMLInputElement>(
                    `input[name=remove]`
                )!.checked;

            callback(
                avoid_hour,
                avoid_reason,
                avoid_reason_txt,
                del_chk ? 1 : 0
            );
        });

        document.body.appendChild(element);
    },

    admin: (
        preData: GalleryPreData,
        frame: IFrame,
        toggleBlur: boolean,
        eventBus: RefresherEventBus,
        useKeyPress: boolean
    ) => {
        const preFoundBlockElement = document.querySelector(
            ".refresher-block-popup"
        );

        preFoundBlockElement?.parentElement?.removeChild(preFoundBlockElement);

        const preFoundElement = document.querySelector(
            ".refresher-management-panel"
        );

        preFoundElement?.parentElement?.removeChild(preFoundElement);

        let setAsNotice = !preData.notice;
        let setAsRecommend = !preData.recommend;

        const element = document.createElement("div");
        element.id = "refresher-management-panel";
        element.className = "refresher-management-panel";

        if (toggleBlur) element.classList.add("blur");

        const upvoteImage = browser.runtime.getURL("/assets/icons/upvote.png");
        const downvoteImage = browser.runtime.getURL(
            "/assets/icons/downvote.png"
        );

        element.innerHTML = `
      <div class="button pin">
        <img src="${browser.runtime.getURL("/assets/icons/pin.png")}"></img>
        <p>${setAsNotice ? "공지로 등록" : "공지 등록 해제"}</p>
      </div>
      <div class="button recommend">
        <img src="${setAsRecommend ? upvoteImage : downvoteImage}"></img>
        <p>${setAsRecommend ? "개념글 등록" : "개념글 해제"}</p>
      </div>
      <div class="button block">
        <img src="${browser.runtime.getURL("/assets/icons/block.png")}"></img>
        <p>차단</p>
      </div>
      <div class="button delete">
        <img src="${browser.runtime.getURL("/assets/icons/delete.png")}"></img>
        <p>삭제 (D)</p>
      </div>
    `;

        const deleteFunction = () => {
            frame.app.close();

            request.delete(preData).then((response) => {
                if (typeof response === "object") {
                    if (response.result === "success") {
                        Toast.show("게시글을 삭제했습니다.", false, 600);
                    } else {
                        Toast.show(response.message, true, 600);
                        alert(`${response.result}: ${response.message}`);
                    }

                    return;
                }

                alert(response);
            });
        };

        element
            .querySelector(".delete")
            ?.addEventListener("click", deleteFunction);

        if (adminKeyPress) {
            document.removeEventListener("keypress", adminKeyPress);
        }

        if (useKeyPress) {
            adminKeyPress = (ev: KeyboardEvent) => {
                if (ev.code !== "KeyB" && ev.code !== "KeyD") {
                    return ev;
                }

                if (frame.app.inputFocus) {
                    return ev;
                }

                if (KEY_COUNTS[ev.code]) {
                    if (Date.now() - KEY_COUNTS[ev.code][0] > 1000) {
                        KEY_COUNTS[ev.code] = [Date.now(), 0];
                    }
                } else {
                    KEY_COUNTS[ev.code] = [Date.now(), 0];
                }

                KEY_COUNTS[ev.code][0] = Date.now();
                KEY_COUNTS[ev.code][1]++;

                if (ev.code === "KeyD") {
                    if (KEY_COUNTS[ev.code][1] >= 2) {
                        deleteFunction();
                        KEY_COUNTS[ev.code][1] = 0;
                    } else {
                        Toast.show(
                            "한번 더 D키를 누르면 게시글을 삭제합니다.",
                            true,
                            1000
                        );
                    }
                }

                // TODO : 차단 프리셋이 지정된 경우 차단

                // else if (ev.code === 'KeyB') {
                //   if (KEY_COUNTS[ev.code][1] > 2) {
                //     // deleteFunction()
                //   } else {
                //     Toast.show('한번 더 B키를 누르면 차단합니다.', true, 1000)
                //   }
                // }
            };
        }

        document.addEventListener("keypress", adminKeyPress);

        element.querySelector(".block")!.addEventListener("click", () => {
            panel.block(
                (
                    avoid_hour: number,
                    avoid_reason: number,
                    avoid_reason_txt: string,
                    del_chk: number
                ) => {
                    request
                        .block(
                            preData,
                            avoid_hour,
                            avoid_reason,
                            avoid_reason_txt,
                            del_chk
                        )
                        .then((response) => {
                            if (typeof response === "object") {
                                if (response.result === "success") {
                                    Toast.show(response.message, false, 3000);

                                    if (del_chk) {
                                        frame.app.close();
                                    }
                                } else {
                                    alert(
                                        `${response.result}: ${response.message}`
                                    );
                                }

                                return;
                            }

                            alert(response);
                        });
                },
                () => {
                    const blockPopup = document.querySelector(
                        ".refresher-block-popup"
                    );
                    blockPopup?.remove();
                }
            );
        });

        const pin = element.querySelector<HTMLElement>(".pin")!;

        pin.addEventListener("click", () => {
            request.setNotice(preData, setAsNotice).then((response) => {
                eventBus.emit("refreshRequest");

                if (typeof response === "object") {
                    if (response.result === "success") {
                        Toast.show(response.message, false, 3000);

                        setAsNotice = !setAsNotice;

                        const pinP = pin.querySelector<HTMLElement>("p")!;

                        pinP.innerHTML = setAsNotice
                            ? "공지로 등록"
                            : "공지 등록 해제";
                    } else {
                        alert(`${response.result}: ${response.message}`);
                    }

                    return;
                }

                alert(response);
            });
        });

        const recommend = element.querySelector<HTMLElement>(".recommend")!;
        recommend.addEventListener("click", () => {
            request.setRecommend(preData, setAsRecommend).then((response) => {
                eventBus.emit("refreshRequest");

                if (typeof response === "object") {
                    if (response.result === "success") {
                        Toast.show(response.message, false, 3000);

                        setAsRecommend = !setAsRecommend;

                        const recommendImg = recommend.querySelector(
                            "img"
                        ) as HTMLImageElement;
                        recommendImg.src = setAsRecommend
                            ? upvoteImage
                            : downvoteImage;

                        const recommendP = recommend.querySelector(
                            "p"
                        ) as HTMLParagraphElement;
                        recommendP.innerHTML = setAsRecommend
                            ? "개념글 등록"
                            : "개념글 해제";
                    } else {
                        alert(`${response.result}: ${response.message}`);
                    }

                    return;
                }

                alert(response);
            });
        });

        document.body.appendChild(element);

        return element;
    },

    captcha(src: string, callback: (captcha: string) => void): boolean {
        const element = document.createElement("div");
        element.className = "refresher-captcha-popup";

        element.innerHTML = `
    <p>코드 입력</p>
    <div class="close">
      <div class="cross"></div>
      <div class="cross"></div>
    </div>
    <img src="${src}"></img>
    <input type="text"></input>
    <button class="refresher-preview-button primary">
      <p class="refresher-vote-text">전송</p>
    </button>
    `;

        const inputEvent = () => {
            const input = element.querySelector("input")!.value;

            if (!input) return;

            callback(input);
            element.parentElement!.removeChild(element);
        };

        setTimeout(() => {
            element.querySelector("input")!.focus();
        }, 0);

        element.querySelector("input")!.addEventListener("keydown", (e) => {
            if (e.key === "Enter") inputEvent();
        });

        element.querySelector(".close")!.addEventListener("click", () => {
            element.parentElement!.removeChild(element);
        });

        element.querySelector("button")!.addEventListener("click", inputEvent);

        document.body.appendChild(element);

        return true;
    }
};

const getRelevantData = (ev: MouseEvent) => {
    const target = ev.target as HTMLElement;
    const isTR = target.tagName === "TR";

    const listID = isTR
        ? target.querySelector<HTMLElement>(".gall_num")
        : findNeighbor(target, ".gall_num", 5, null);

    let id = "";
    let gallery = "";
    let title = "";
    let link = "";
    let notice = false;
    let recommend = false;

    let linkElement: HTMLLinkElement | null;

    if (listID) {
        if (listID.innerText === "공지") {
            let href: string;

            if (isTR) {
                href = document.querySelector("a")?.getAttribute("href") ?? "";
            } else {
                href =
                    findNeighbor(target, "a", 5, null)?.getAttribute("href") ??
                    "";
            }

            id = new URLSearchParams(href).get("no") ?? "";
            notice = true;
        } else {
            id = listID.innerText;
        }

        const emElement = isTR
            ? target.querySelector("em.icon_img")
            : findNeighbor(target, "em.icon_img", 5, null);
        if (emElement) {
            recommend = emElement.classList.contains("icon_recomimg");
        }

        linkElement = isTR
            ? target.querySelector<HTMLLinkElement>("a:not(.reply_numbox)")
            : (findNeighbor(
                  target,
                  "a:not(.reply_numbox)",
                  3,
                  null
              ) as HTMLLinkElement);

        if (linkElement) title = linkElement.innerText;
    } else {
        linkElement = isTR
            ? target.querySelector<HTMLLinkElement>("a")
            : (findNeighbor(
                  ev.target as HTMLElement,
                  "a",
                  2,
                  null
              ) as HTMLLinkElement);

        const pt = isTR
            ? target.querySelector(".txt_box")
            : findNeighbor(ev.target as HTMLElement, ".txt_box", 2, null);
        if (pt) title = pt.innerHTML;
    }

    if (linkElement) {
        link = linkElement.href;

        const linkNumberMatch = link.match(/&no=.+/);
        const linkIdMatch = link.match(/id=.+/);

        if (!linkNumberMatch || !linkIdMatch) {
            return;
        }

        id = linkNumberMatch[0].replace("&no=", "").replace(/&.+/g, "");
        gallery = linkIdMatch[0].replace(/id=/g, "").replace(/&.+/g, "");
    }

    return {
        id,
        gallery,
        title,
        link,
        notice,
        recommend
    };
};

interface Cache {
    post?: PostInfo;
    comment?: DcinsideComments;
}

class PostCache {
    #caches: Record<string, Cache> = {};

    constructor(public maxCacheSize: number = 50) {}

    public get(id: string): Cache | undefined {
        return this.#caches[id];
    }

    public set(id: string, data: Cache): void {
        if (Object.keys(this.#caches).length > this.maxCacheSize) {
            const lastCache = Object.entries(this.#caches)[0]![0];
            this.delete(lastCache);
        }

        this.#caches[id] ??= {};
        this.#caches[id] = {
            ...this.get(id),
            ...data
        };
    }

    public delete(id: string): boolean {
        if (!this.#caches[id]) return false;

        delete this.#caches[id];
        return true;
    }
}

const postCaches = new PostCache();

const miniPreview: MiniPreview = {
    element: document.createElement("div"),
    init: false,
    lastRequest: 0,
    controller: new AbortController(),
    lastElement: null,
    lastTimeout: 0,
    shouldOutHandle: false,
    cursorOut: false,
    create(ev, use, hide) {
        if (!use) return;

        miniPreview.cursorOut = false;

        if (Date.now() - miniPreview.lastRequest < 150) {
            miniPreview.lastRequest = Date.now();
            miniPreview.lastElement = ev.target;

            if (miniPreview.lastTimeout) clearTimeout(miniPreview.lastTimeout);

            miniPreview.lastTimeout = window.setTimeout(() => {
                if (
                    !miniPreview.cursorOut &&
                    miniPreview.lastElement === ev.target
                ) {
                    miniPreview.create(ev, use, hide);
                }

                miniPreview.cursorOut = false;
            }, 150);

            return;
        }

        miniPreview.lastRequest = Date.now();

        const preData = getRelevantData(ev);

        if (!preData) return;

        miniPreview.element.classList.remove("hide");
        miniPreview.element.classList.add("refresher-mini-preview");

        if (!miniPreview.init) {
            miniPreview.element.innerHTML = `<h3>${
                preData.title
            }</h3><br><div class="refresher-mini-preview-contents${
                hide ? " media-hide" : ""
            }"></div><p class="read-more">더 읽으려면 클릭하세요.</p>`;

            document.body.appendChild(miniPreview.element);
            miniPreview.init = true;
        }

        const selector = miniPreview.element.querySelector(
            ".refresher-mini-preview-contents"
        );

        if (!selector) return;

        new Promise<PostInfo>((resolve, reject) => {
            const cache = postCaches.get(`${preData.gallery}${preData.id}`);

            if (cache?.post) {
                resolve(cache.post);
                return;
            }

            request
                .post(
                    preData.link,
                    preData.gallery,
                    preData.id,
                    miniPreview.controller.signal
                )
                .then((response) => {
                    if (!response) {
                        reject();
                        return;
                    }

                    postCaches.set(`${preData.gallery}${preData.id}`, {
                        post: response
                    });
                    resolve(response);
                });
        })
            .then((v) => {
                const content = v.contents ?? "";

                selector.innerHTML = block.check("TEXT", content)
                    ? "게시글 내용이 차단됐습니다."
                    : content;
                selector.querySelector(".write_div")?.setAttribute("style", "");
            })
            .catch((error) => {
                selector.innerHTML = error.toString().includes("aborted")
                    ? ""
                    : `게시글을 새로 가져올 수 없습니다: ${error}`;
            });

        miniPreview.element.querySelector("h3")!.innerHTML = preData.title;
    },

    move(ev: MouseEvent, use: boolean) {
        if (!use) return;

        const rect = miniPreview.element.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;
        const x = Math.min(ev.clientX, innerWidth - width - 10);
        const y = Math.min(ev.clientY, innerHeight - height - 10);
        miniPreview.element.style.transform = `translate(${x}px, ${y}px)`;
    },

    close(use: boolean) {
        miniPreview.cursorOut = true;

        if (use) {
            miniPreview.controller.abort();
            miniPreview.controller = new AbortController();
        }

        miniPreview.element.classList.add("hide");
    }
};

let frame: IFrame;

export default {
    name: "미리보기",
    description: "글을 오른쪽 클릭 했을때 미리보기 창을 만들어줍니다.",
    url: /gall\.dcinside\.com\/(mgallery\/|mini\/)?board\/(view|lists)/g,
    status: {},
    memory: {
        preventOpen: false,
        lastPress: 0,
        uuid: null,
        uuid2: null,
        popStateHandler: null,
        signal: null,
        historyClose: false,
        titleStore: null,
        urlStore: null,
        refreshIntervalId: null
    },
    enable: true,
    default_enable: true,
    settings: {
        tooltipMode: {
            name: "툴팁 미리보기 표시",
            desc: "마우스를 올려두면 글 내용만 빠르게 볼 수 있는 툴팁을 추가합니다.",
            type: "check",
            default: false
        },
        tooltipMediaHide: {
            name: "툴팁 미리보기 미디어 숨기기",
            desc: "툴팁 미리보기 화면에서 미디어를 숨깁니다.",
            type: "check",
            default: false
        },
        reversePreviewKey: {
            name: "키 반전",
            desc: "오른쪽 버튼 대신 왼쪽 버튼으로 미리보기를 엽니다.",
            type: "check",
            default: false
        },
        longPressDelay: {
            name: "기본 마우스 오른쪽 클릭 딜레이",
            desc: "마우스 오른쪽 버튼을 해당 밀리초 이상 눌러 뗄 때 기본 우클릭 메뉴가 나오게 합니다.",
            type: "range",
            default: 300,
            min: 200,
            max: 2000,
            step: 50,
            unit: "ms"
        },
        scrollToSkip: {
            name: "스크롤하여 게시글 이동",
            desc: "맨 위나 아래로 스크롤하여 다음 게시글로 이동할 수 있게 합니다.",
            type: "check",
            default: true
        },
        colorPreviewLink: {
            name: "게시글 URL 변경",
            desc: "미리보기를 열면 게시글의 URL을 변경하여 브라우저 탐색으로 게시글을 바꿀 수 있게 해줍니다.",
            type: "check",
            default: true
        },
        autoRefreshComment: {
            name: "댓글 자동 새로고침",
            desc: "댓글을 일정 주기마다 자동으로 새로고침합니다.",
            type: "check",
            default: false
        },
        commentRefreshInterval: {
            name: "댓글 자동 새로고침 주기",
            desc: "위의 옵션이 켜져있을 시 댓글을 새로고침할 주기를 설정합니다.",
            type: "range",
            default: 10,
            min: 1,
            max: 20,
            step: 1,
            unit: "s"
        },
        toggleBlur: {
            name: "게시글 배경 블러 활성화",
            desc: "미리보기 창의 배경을 블러 처리하여 미관을 돋보이게 합니다. (성능 하락 영향 있음)",
            type: "check",
            default: true
        },
        toggleBackgroundBlur: {
            name: "바깥 배경 블러 활성화",
            desc: "미리보기 창의 바깥 배경을 블러 처리하여 미관을 돋보이게 합니다. (성능 하락 영향 있음)",
            type: "check",
            default: false
        },
        toggleAdminPanel: {
            name: "관리 패널 활성화",
            desc: "갤러리에 관리 권한이 있는 경우 창 옆에 관리 패널을 표시합니다.",
            type: "check",
            default: true
        },
        useKeyPress: {
            name: "관리 패널 > 키 제어",
            desc: "관리 패널이 활성화된 경우 단축키를 눌러 빠르게 관리할 수 있습니다.",
            type: "check",
            default: true
        },
        expandRecognizeRange: {
            name: "게시글 목록 인식 범위 확장",
            desc: "게시글의 오른쪽 클릭을 인식하는 범위를 칸 전체로 확장합니다.",
            type: "check",
            default: false
        },
        experimentalComment: {
            name: "댓글 기능 활성화",
            desc: "댓글을 작성할 수 있습니다.",
            type: "check",
            default: false
        },
        disableCache: {
            name: "캐시 비활성화",
            desc: "캐시를 사용하지 않습니다. (툴팁 미리보기 제외)",
            type: "check",
            default: true
        }
    },
    update: {
        experimentalComment(this, value: boolean) {
            if (!value || !navigator.userAgent.includes("Firefox")) return;

            alert(
                "Firefox 사생활 보호 모드에서는 댓글 기능이 작동하지 않습니다.\n해당 기능을 사용하려면 GitHub Discussions을 참고해주세요."
            );
        }
    },
    require: ["filter", "eventBus", "Frame", "http"],
    func(
        filter: RefresherFilter,
        eventBus: RefresherEventBus,
        Frame: typeof IFrame,
        http: RefresherHTTP
    ) {
        let postFetchedData: PostInfo;
        const gallery = queryString("id") ?? undefined;

        const makeFirstFrame = (
            frame: RefresherFrame,
            preData: GalleryPreData,
            signal: AbortSignal,
            historySkip?: boolean
        ) => {
            frame.data.load = true;
            frame.title = preData.title!;
            frame.data.buttons = true;

            if (this.status.colorPreviewLink) {
                const title = `${preData.title} - ${document.title
                    .split("-")
                    .slice(-1)[0]
                    .trim()}`;

                if (!historySkip) {
                    history.pushState(
                        { preData, preURL: location.href },
                        title,
                        preData.link
                    );
                }

                document.title = title;
            }

            frame.functions.vote = async (type: number) => {
                if (frame.collapse) {
                    Toast.show(
                        "댓글 보기를 클릭하여 댓글만 표시합니다.",
                        true,
                        3000
                    );
                    return false;
                }

                if (!postFetchedData) {
                    Toast.show(
                        "게시글이 로딩될 때까지 잠시 기다려주세요.",
                        true,
                        3000
                    );
                    return false;
                }

                const codeSrc = postFetchedData.requireCaptcha
                    ? await request.captcha(preData, "recommend")
                    : undefined;

                const req = async (captcha?: string) => {
                    const res = await request.vote(
                        preData.gallery,
                        preData.id,
                        type,
                        captcha ?? undefined,
                        preData.link!
                    );

                    if (res.result !== "true") {
                        Toast.show(res.counts, true, 2000);

                        return false;
                    }

                    frame[type ? "upvotes" : "downvotes"] = res.counts.replace(
                        /\B(?=(\d{3})+(?!\d))/g,
                        ","
                    );

                    return true;
                };

                return codeSrc ? panel.captcha(codeSrc, req) : req();
            };

            frame.functions.share = () => {
                navigator.clipboard.writeText(
                    `https://gall.dcinside.com/${http.galleryType(
                        preData.link!
                    )}/board/view/?id=${
                        preData.gallery || http.queryString("id")
                    }&no=${preData.id}`
                );

                Toast.show("클립보드에 복사되었습니다.", false, 3000);

                return true;
            };

            frame.functions.load = (useCache = true) => {
                frame.data.load = true;

                new Promise<PostInfo>((resolve, reject) => {
                    if (!this.status.disableCache) {
                        const cache = postCaches.get(
                            `${preData.gallery}${preData.id}`
                        );

                        if (useCache && cache?.post !== undefined) {
                            resolve(cache.post);
                            return;
                        }
                    }

                    request
                        .post(
                            preData.link!,
                            preData.gallery,
                            preData.id,
                            signal
                        )
                        .then((response) => {
                            if (!response) {
                                reject();
                                return;
                            }

                            postCaches.set(`${preData.gallery}${preData.id}`, {
                                post: response
                            });
                            resolve(response);
                        })
                        .catch((error) => {
                            reject(error);
                        });
                })
                    .then((postInfo) => {
                        if (this.status.colorPreviewLink) {
                            const title = `${postInfo.title} - ${document.title
                                .split("-")
                                .slice(-1)[0]
                                .trim()}`;

                            if (!historySkip) {
                                preData.title = postInfo.title;
                                history.replaceState(
                                    { preData, preURL: location.href },
                                    title,
                                    preData.link
                                );
                            }

                            document.title = title;
                        }

                        postFetchedData = postInfo;

                        if (postInfo.isAdult) {
                            frame.error = {
                                title: "성인 인증이 필요한 게시글입니다.",
                                detail: "성인 인증을 하신 후 다시 시도해주세요."
                            };
                        } else {
                            frame.contents = block.check(
                                "TEXT",
                                postInfo.contents ?? "",
                                gallery
                            )
                                ? "게시글 내용이 차단됐습니다."
                                : postInfo.contents;
                            frame.upvotes = postInfo.upvotes;
                            frame.fixedUpvotes = postInfo.fixedUpvotes;
                            frame.downvotes = postInfo.downvotes;

                            if (frame.title !== postInfo.title)
                                frame.title = postInfo.title!;

                            frame.data.disabledDownvote =
                                postInfo.disabledDownvote ?? false;

                            frame.data.user = postInfo.user;

                            if (postInfo.date) {
                                frame.data.date = new Date(
                                    postInfo.date.replace(/\./g, "-")
                                );
                            }

                            if (postInfo.expire) {
                                frame.data.expire = new Date(postInfo.expire);
                            }

                            frame.data.buttons = true;
                            frame.data.views = `조회 ${postInfo.views}회`;
                        }

                        eventBus.emit("RefresherPostDataLoaded", postInfo);
                        eventBus.emit(
                            "RefresherPostCommentIDLoaded",
                            postInfo.commentId,
                            postInfo.commentNo
                        );
                        eventBus.emitNextTick("contentPreview", frame.app.$el);

                        frame.data.load = false;
                    })
                    .catch((error) => {
                        frame.error = {
                            title: "게시글",
                            detail: error
                        };

                        logger("Error occured while loading a post.", error);

                        frame.data.load = false;
                    });
            };

            frame.functions.retry = (useCache = false) => {
                frame.functions.load(useCache);
            };

            if (!frame.collapse) frame.functions.load();

            frame.functions.openOriginal = () => {
                if (this.status.colorPreviewLink) location.reload();
                else location.href = preData.link!;

                return true;
            };
        };

        const makeSecondFrame = (
            frame: RefresherFrame,
            preData: GalleryPreData,
            signal: AbortSignal
        ) => {
            frame.data.load = true;
            frame.title = "댓글";
            frame.subtitle = "로딩 중";
            frame.data.useWriteComment = this.status.experimentalComment;

            let postDom: Document;

            new Promise<GalleryPreData>((resolve) => {
                eventBus.on(
                    "RefresherPostCommentIDLoaded",
                    (commentId: string, commentNo: string) =>
                        resolve({
                            gallery: commentId,
                            id: commentNo
                        }),
                    {
                        once: true
                    }
                );
            }).then((postData) => {
                if (postFetchedData) postDom = postFetchedData.dom!;
                else
                    eventBus.on(
                        "RefresherPostDataLoaded",
                        (obj: PostInfo) => {
                            postDom = obj.dom!;
                        },
                        {
                            once: true
                        }
                    );

                frame.functions.writeComment = async (
                    type: "text" | "dccon",
                    memo: string | DcinsideDccon,
                    reply: string | null,
                    user: { name: string; pw?: string }
                ) => {
                    if (!postFetchedData) {
                        Toast.show(
                            "게시글이 로딩될 때까지 잠시 기다려주세요.",
                            true,
                            3000
                        );
                        return false;
                    }

                    const requireCapCode =
                        postFetchedData.requireCommentCaptcha;

                    const codeSrc = requireCapCode
                        ? await request.captcha(preData, "comment")
                        : undefined;

                    const req = async (captcha?: string) => {
                        const res = await submitComment(
                            postData,
                            user,
                            postDom,
                            memo,
                            reply,
                            captcha
                        );

                        if (
                            res.result === "false" ||
                            res.result === "PreNotWorking"
                        ) {
                            alert(res.message);
                            return false;
                        } else {
                            return true;
                        }
                    };

                    return codeSrc ? panel.captcha(codeSrc, req) : req();
                };

                if (this.memory.refreshIntervalId)
                    clearInterval(this.memory.refreshIntervalId);

                this.memory.refreshIntervalId = window.setInterval(() => {
                    if (this.status.autoRefreshComment) frame.functions.retry();
                }, this.status.commentRefreshInterval * 1000);
            });

            const deletePressCount: Record<string, number> = {};

            frame.functions.deleteComment = async (
                commentId: string,
                password: string,
                admin: boolean
            ) => {
                if (!preData.link) return false;

                if (!password) {
                    if (deletePressCount[commentId] + 1000 < Date.now()) {
                        deletePressCount[commentId] = 0;
                    }

                    if (!deletePressCount[commentId]) {
                        Toast.show(
                            "한번 더 누르면 댓글을 삭제합니다.",
                            true,
                            1000
                        );

                        deletePressCount[commentId] = Date.now();

                        return false;
                    }

                    deletePressCount[commentId] = 0;
                }

                const typeName = http.galleryTypeName(preData.link);
                if (!typeName.length) return false;

                return (
                    admin && !password
                        ? request.adminDeleteComment(preData, commentId, signal)
                        : request.userDeleteComment(
                              preData,
                              commentId,
                              signal,
                              password
                          )
                )
                    .then((v) => {
                        if (typeof v === "boolean") {
                            if (!v) return false;

                            return v;
                        }

                        if (v.includes("||")) {
                            const parsed = v.split("||");

                            if (parsed[0] !== "true") {
                                Toast.show(parsed[1], true, 3000);

                                return false;
                            }
                        }

                        if (v[0] !== "{") {
                            if (v !== "true") {
                                Toast.show(v, true, 3000);
                                return false;
                            }

                            Toast.show("댓글을 삭제하였습니다.", false, 3000);
                        } else {
                            const parsed = JSON.parse(v);

                            if (parsed.result !== "fail") {
                                Toast.show(
                                    "댓글을 삭제하였습니다.",
                                    false,
                                    3000
                                );
                            } else {
                                Toast.show(parsed.msg, true, 5000);
                            }
                        }

                        frame.functions.load();

                        return true;
                    })
                    .catch(() => false);
            };

            frame.functions.load = (useCache = true) => {
                frame.data.load = true;

                new Promise<DcinsideComments>((resolve, reject) => {
                    if (!this.status.disableCache) {
                        const cache = postCaches.get(
                            `${preData.gallery}${preData.id}`
                        );

                        if (useCache && cache?.comment) {
                            resolve(cache.comment);
                            return;
                        }
                    }

                    request
                        .comments(
                            {
                                link: preData.link!,
                                gallery: preData.gallery,
                                id: preData.id
                            },
                            signal
                        )
                        .then((response) => {
                            if (!response) {
                                reject();
                                return;
                            }

                            postCaches.set(`${preData.gallery}${preData.id}`, {
                                comment: response
                            });
                            resolve(response);
                        });
                })
                    .then((comments) => {
                        let threadCounts = 0;

                        if (comments.comments !== null) {
                            comments.comments = comments.comments.filter(
                                (v: DcinsideCommentObject) => {
                                    return v.nicktype !== "COMMENT_BOY";
                                }
                            );

                            comments.comments.map(
                                (v: DcinsideCommentObject) => {
                                    v.user = new User(
                                        v.name,
                                        v.user_id || null,
                                        v.ip || null,
                                        new DOMParser()
                                            .parseFromString(
                                                v.gallog_icon,
                                                "text/html"
                                            )
                                            .querySelector(
                                                "a.writer_nikcon img"
                                            )
                                            ?.getAttribute("src") || null
                                    );
                                }
                            );

                            comments.comments = comments.comments.filter(
                                (comment: DcinsideCommentObject) => {
                                    const check: {
                                        [index in RefresherBlockType]?: string;
                                    } = {
                                        NICK: comment.name
                                    };

                                    if (comment.user_id !== null) {
                                        check.ID = comment.user_id;
                                    }

                                    if (comment.ip !== null) {
                                        check.IP = comment.ip;
                                    }

                                    if (
                                        /<(img|video) class=/.test(comment.memo)
                                    ) {
                                        check.DCCON =
                                            /https:\/\/dcimg5\.dcinside\.com\/dccon\.php\?no=(\w*)/g.exec(
                                                comment.memo
                                            )![1];
                                    } else {
                                        check.COMMENT = comment.memo;
                                    }

                                    return !block.checkAll(check, gallery);
                                }
                            );

                            threadCounts = comments.comments
                                .map((v: DcinsideCommentObject) =>
                                    Number(v.depth == 0)
                                )
                                .reduce((a: number, b: number) => a + b);
                        }

                        frame.subtitle = `${
                            (comments.total_cnt !== threadCounts &&
                                `쓰레드 ${threadCounts}개, 총 댓글`) ||
                            ""
                        } ${comments.total_cnt}개`;

                        frame.data.comments = comments;
                        frame.data.load = false;
                    })
                    .catch((error) => {
                        frame.error = {
                            title: "댓글",
                            detail: error
                        };
                    });
            };

            frame.functions.load();
            frame.functions.retry = (useCache = false) => {
                frame.functions.load(useCache);
            };
        };

        const newPostWithData = (
            preData: GalleryPreData,
            historySkip?: boolean
        ) => {
            const firstApp = frame.app.first();
            const secondApp = frame.app.second();

            if (firstApp.data.load) return;

            const params = new URLSearchParams(preData.link);
            params.set("no", preData.id);
            preData.link = decodeURIComponent(params.toString());

            preData.title = "게시글 로딩 중...";
            firstApp.contents = "";

            makeFirstFrame(firstApp, preData, this.memory.signal!, historySkip);
            makeSecondFrame(secondApp, preData, this.memory.signal!);

            if (
                this.status.toggleAdminPanel &&
                document.querySelector(".useradmin_btnbox button") !== null
            ) {
                panel.admin(
                    preData,
                    frame,
                    this.status.toggleBlur,
                    eventBus,
                    this.status.useKeyPress
                );
            }
        };

        const previewFrame = (
            ev: MouseEvent | null,
            prd?: GalleryPreData,
            historySkip?: boolean
        ) => {
            if (this.memory.preventOpen) {
                this.memory.preventOpen = false;

                return;
            }

            if ((ev?.target as HTMLElement)?.closest(".ub-writer")) {
                return;
            }

            miniPreview.close(this.status.tooltipMode);

            const preData = ev === null ? prd : getRelevantData(ev);

            if (preData === undefined) return;

            let collapseView = false;

            if (ev?.target instanceof HTMLElement) {
                collapseView = ev.target.className.includes("reply_num");
            }

            if (!historySkip) {
                this.memory.titleStore = document.title;
                this.memory.urlStore = location.href;
            }

            const controller = new AbortController();
            this.memory.signal = controller.signal;

            let appStore: RefresherFrameAppVue;
            let groupStore: HTMLElement;

            const detector = new ScrollDetection();
            let scrolledCount = 0;

            if (!frame) {
                frame = new Frame(
                    [
                        {
                            relative: true,
                            center: true,
                            preview: true,
                            blur: this.status.toggleBlur
                        },
                        {
                            relative: true,
                            center: true,
                            preview: true,
                            blur: this.status.toggleBlur
                        }
                    ],
                    {
                        background: true,
                        stack: true,
                        groupOnce: true,
                        onScroll: (
                            ev: WheelEvent,
                            app: RefresherFrameAppVue,
                            group: HTMLElement
                        ) => {
                            if (!this.status.scrollToSkip) return;

                            appStore = app;
                            groupStore = group;

                            detector.addMouseEvent(ev);
                        },
                        blur: this.status.toggleBackgroundBlur
                    }
                );

                detector.listen("scroll", (ev: WheelEvent) => {
                    const scrolledTop = groupStore.scrollTop === 0;

                    const scroll = Math.floor(
                        groupStore.scrollHeight - groupStore.scrollTop
                    );

                    const scrolledToBottom =
                        scroll === groupStore.clientHeight ||
                        scroll + 1 === groupStore.clientHeight;

                    if (!scrolledTop && !scrolledToBottom) {
                        scrolledCount = 0;
                    }

                    if (ev.deltaY < 0) {
                        appStore.$data.scrollModeBottom = false;
                        appStore.$data.scrollModeTop = true;

                        if (!scrolledTop) {
                            appStore.$data.scrollModeTop = false;
                            appStore.$data.scrollModeBottom = false;
                        }

                        if (!scrolledTop || !preData) return;

                        if (scrolledCount++ < 1) return;

                        scrolledCount = 0;

                        preData.id = (Number(preData.id) - 1).toString();

                        newPostWithData(preData, historySkip);
                        groupStore.scrollTop = 0;
                        appStore.clearScrollMode();
                    } else {
                        appStore.$data.scrollModeTop = false;
                        appStore.$data.scrollModeBottom = true;

                        if (!scrolledToBottom) {
                            appStore.$data.scrollModeTop = false;
                            appStore.$data.scrollModeBottom = false;
                        }

                        if (!scrolledToBottom || !preData) {
                            return;
                        }

                        if (scrolledCount++ < 1) return;

                        scrolledCount = 0;

                        if (!frame || !frame.app.first().error) {
                            preData.id = (Number(preData.id) + 1).toString();
                        }

                        newPostWithData(preData, historySkip);

                        groupStore.scrollTop = 0;
                        appStore.clearScrollMode();
                    }
                });

                frame.app.$on("close", () => {
                    controller.abort();

                    const blockPopup = document.querySelector(
                        ".refresher-block-popup"
                    );
                    blockPopup?.remove();

                    const captchaPopup = document.querySelector(
                        ".refresher-captcha-popup"
                    );
                    captchaPopup?.remove();

                    const adminPanel = document.querySelector(
                        ".refresher-management-panel"
                    );
                    adminPanel?.remove();

                    if (typeof adminKeyPress === "function") {
                        document.removeEventListener("keypress", adminKeyPress);
                    }

                    if (!this.memory.historyClose && this.memory.titleStore) {
                        history.pushState(
                            null,
                            this.memory.titleStore,
                            this.memory.urlStore
                        );

                        this.memory.historyClose = false;
                    }

                    if (this.memory.titleStore) {
                        document.title = this.memory.titleStore;
                    }

                    window.clearInterval(this.memory.refreshIntervalId!);
                });
            }

            frame.app.closed = false;

            frame.app.first().collapse = collapseView;

            makeFirstFrame(
                frame.app.first(),
                preData,
                this.memory.signal!,
                historySkip
            );

            makeSecondFrame(frame.app.second(), preData, this.memory.signal!);

            if (
                this.status.toggleAdminPanel &&
                document.querySelector(".useradmin_btnbox button") !== null
            ) {
                panel.admin(
                    preData,
                    frame,
                    this.status.toggleBlur,
                    eventBus,
                    this.status.useKeyPress
                );
            }

            setTimeout(() => {
                frame.app.fadeIn();
            }, 0);

            ev?.preventDefault();
        };

        const handleMousePress = (ev: MouseEvent) => {
            if (ev.button !== 2) {
                return ev;
            }

            if (ev.type === "mousedown") {
                this.memory.lastPress = Date.now();
                return ev;
            }

            if (
                ev.type === "mouseup" &&
                Date.now() - this.status.longPressDelay > this.memory.lastPress
            ) {
                this.memory.preventOpen = true;
                this.memory.lastPress = 0;
                return ev;
            }
        };

        const addHandler = (element: HTMLElement) => {
            element.addEventListener("mouseup", handleMousePress);
            element.addEventListener("mousedown", handleMousePress);
            element.addEventListener(
                this.status.reversePreviewKey ? "click" : "contextmenu",
                previewFrame
            );

            if (this.status.reversePreviewKey) {
                element.addEventListener("contextmenu", (e) => {
                    e.preventDefault();

                    let href = (e.target as HTMLAnchorElement).href;

                    if (!href) {
                        if ((e.target as HTMLElement).tagName === "TR") {
                            href =
                                document
                                    .querySelector("a")
                                    ?.getAttribute("href") ?? "";
                        } else {
                            href =
                                findNeighbor(
                                    e.target as HTMLElement,
                                    "a",
                                    5,
                                    null
                                )?.getAttribute("href") ?? "";
                        }
                    }

                    location.href = href;
                });
            }

            element.addEventListener("mouseenter", (ev) =>
                miniPreview.create(
                    ev,
                    this.status.tooltipMode,
                    this.status.tooltipMediaHide
                )
            );
            element.addEventListener("mousemove", (ev) =>
                miniPreview.move(ev, this.status.tooltipMode)
            );
            element.addEventListener("mouseleave", () =>
                miniPreview.close(this.status.tooltipMode)
            );
        };

        this.memory.uuid = filter.add(
            `.gall_list .us-post${
                this.status.expandRecognizeRange ? "" : " .ub-word"
            }`,
            addHandler,
            { neverExpire: true }
        );
        this.memory.uuid2 = filter.add("#right_issuezoom", addHandler);

        this.memory.popStateHandler = (ev: PopStateEvent) => {
            if (!ev.state) {
                this.memory.historyClose = true;

                try {
                    frame.app.close();
                } catch {
                    location.reload();
                }

                return;
            }

            this.memory.historyClose = false;

            if (frame.app.closed) {
                previewFrame(null, ev.state.preData, true);
            } else {
                newPostWithData(ev.state.preData, true);
            }
        };

        window.addEventListener("popstate", this.memory.popStateHandler);
    },
    revoke(filter: RefresherFilter) {
        if (this.memory.uuid) filter.remove(this.memory.uuid, true);

        if (this.memory.uuid2) filter.remove(this.memory.uuid2, true);

        if (this.memory.popStateHandler)
            window.removeEventListener("popstate", this.memory.popStateHandler);

        if (this.memory.refreshIntervalId)
            window.clearInterval(this.memory.refreshIntervalId);
    }
} as RefresherModule<{
    memory: {
        preventOpen: boolean;
        lastPress: number;
        uuid: string | null;
        uuid2: string | null;
        popStateHandler: ((ev: PopStateEvent) => void) | null;
        signal: AbortSignal | null;
        historyClose: boolean;
        titleStore: string | null;
        urlStore: string | null;
        refreshIntervalId: number | null;
    };
    settings: {
        tooltipMode: RefresherCheckSettings;
        tooltipMediaHide: RefresherCheckSettings;
        reversePreviewKey: RefresherCheckSettings;
        longPressDelay: RefresherRangeSettings;
        scrollToSkip: RefresherCheckSettings;
        colorPreviewLink: RefresherCheckSettings;
        autoRefreshComment: RefresherCheckSettings;
        commentRefreshInterval: RefresherRangeSettings;
        toggleBlur: RefresherCheckSettings;
        toggleBackgroundBlur: RefresherCheckSettings;
        toggleAdminPanel: RefresherCheckSettings;
        useKeyPress: RefresherCheckSettings;
        expandRecognizeRange: RefresherCheckSettings;
        experimentalComment: RefresherCheckSettings;
        disableCache: RefresherCheckSettings;
    };
    require: ["filter", "eventBus", "Frame", "http"];
}>;
